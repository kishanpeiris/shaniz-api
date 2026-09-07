import { Router } from 'express'
import { z } from 'zod'
import { query, pool } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { logBoth, logAudit } from '../lib/log.js'
import { sendOrderConfirmationEmail, sendShippingNoticeEmail, sendInvoiceEmail, sendFraudAlertEmail } from '../lib/email.js'
import { sendOrderConfirmationSms } from '../lib/sms.js'
import { createCheckoutSession, GATEWAYS } from '../lib/gateways.js'
import { deliveryFee, isValidRegion } from '../lib/delivery.js'
import { evaluateOrderRisk, recordFraudFlags } from '../lib/fraud.js'
import { getSuperadminEmails } from '../lib/notifications.js'

const router = Router()

const lineItemSchema = z.object({
  type: z.enum(['product', 'service']),
  id: z.string().uuid(),
  qty: z.number().int().positive(),
})

// An address as entered at checkout — for both guests and logged-in
// customers. Sri Lanka only, per the checkout requirements (no country
// field — there's only one).
const addressInputSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  line1: z.string().min(1),
  city: z.string().min(1),
  postal_code: z.string().min(1, 'Postal code is required.'),
  phone: z.string().min(7, 'A valid phone number is required.'),
})

const orderSchema = z
  .object({
    items: z.array(lineItemSchema).min(1),
    gateway: z.enum(['koko', 'intpay', 'dialog_genie']),
    guest_email: z.string().email().optional(),

    // Contact — required for everyone, guest or logged-in, per the
    // checkout requirements.
    first_name: z.string().min(1),
    last_name: z.string().min(1),
    phone: z.string().min(7, 'A valid phone number is required.'),

    // Delivery
    delivery_method: z.enum(['pickup', 'delivery']),
    delivery_region: z.string().optional(), // required when delivery_method === 'delivery'
    shipping_address_id: z.string().uuid().optional(), // pick a saved address (logged-in only)
    shipping_address: addressInputSchema.optional(), // or enter a new one

    // Billing — defaults to the shipping address if not provided
    billing_same_as_shipping: z.boolean().optional().default(true),
    billing_address_id: z.string().uuid().optional(),
    billing_address: addressInputSchema.optional(),

    // Only meaningful for card gateways (dialog_genie) with a logged-in
    // customer — see POST /:id/sandbox-pay for where this is fulfilled.
    save_card: z.boolean().optional().default(false),
  })
  .refine((d) => d.delivery_method !== 'delivery' || isValidRegion(d.delivery_region), {
    message: 'A valid delivery region is required for home delivery.',
    path: ['delivery_region'],
  })

async function resolveAddress({ client, userId, addressId, inline, region }) {
  if (addressId) {
    const { rows } = await client.query('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [
      addressId,
      userId,
    ])
    if (!rows[0]) throw new HttpError(400, 'Saved address not found.')
    return {
      first_name: rows[0].first_name,
      last_name: rows[0].last_name,
      line1: rows[0].line1,
      city: rows[0].city,
      postal_code: rows[0].postal_code,
      phone: rows[0].phone,
      region: rows[0].region,
    }
  }
  if (inline) {
    // If the customer is logged in, save this as a new address on their
    // account too, so it shows up next time (Section 2: "Saved shipping
    // details"). Guests just get the snapshot on the order itself.
    if (userId) {
      await client.query(
        `INSERT INTO addresses (user_id, first_name, last_name, line1, city, postal_code, phone, region, address_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'shipping')`,
        [userId, inline.first_name, inline.last_name, inline.line1, inline.city, inline.postal_code, inline.phone, region ?? null]
      )
    }
    return { ...inline, region: region ?? null }
  }
  return null
}

// Create an order. Prices and stock are always re-checked server-side —
// never trust a price the client sends (that's how baskets get exploited).
router.post('/', async (req, res) => {
  const parsed = orderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const d = parsed.data

  if (!req.user && !d.guest_email) {
    return res.status(400).json({ error: 'guest_email is required for guest checkout.' })
  }
  if (d.delivery_method === 'delivery' && !d.shipping_address_id && !d.shipping_address) {
    return res.status(400).json({ error: 'A shipping address is required for delivery.' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const resolvedItems = []
    let subtotal = 0

    for (const item of d.items) {
      const table = item.type === 'product' ? 'products' : 'services'
      const { rows } = await client.query(
        `SELECT id, name, price_lkr${
          item.type === 'product' ? ', stock_qty, availability_mode, preorder_eta_days' : ''
        } FROM ${table} WHERE id = $1 AND is_active = TRUE FOR UPDATE`,
        [item.id]
      )
      const record = rows[0]
      if (!record) throw new HttpError(400, `${item.type} ${item.id} is no longer available.`)

      let isPreorder = false
      let preorderEtaDate = null

      if (item.type === 'product') {
        const hasStock = record.stock_qty >= item.qty
        if (!hasStock && record.availability_mode !== 'preorder') {
          throw new HttpError(409, `Not enough stock for "${record.name}".`)
        }
        if (!hasStock && record.availability_mode === 'preorder') {
          // Pre-ordered: not fulfilled from current inventory, so stock_qty
          // isn't touched. Snapshot a real calendar date now (from the
          // admin's day-count setting) so it stays fixed on this order even
          // if the setting changes later.
          isPreorder = true
          const days = record.preorder_eta_days ?? 14
          const eta = new Date()
          eta.setDate(eta.getDate() + days)
          preorderEtaDate = eta.toISOString().slice(0, 10)
        } else {
          await client.query('UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2', [
            item.qty,
            item.id,
          ])
        }
      }

      const unitPrice = Number(record.price_lkr)
      subtotal += unitPrice * item.qty
      resolvedItems.push({
        type: item.type,
        id: item.id,
        name: record.name,
        unit_price_lkr: unitPrice,
        qty: item.qty,
        ...(isPreorder ? { is_preorder: true, preorder_eta_date: preorderEtaDate } : {}),
      })
    }

    const userId = req.user?.id ?? null

    const shippingSnapshot =
      d.delivery_method === 'delivery'
        ? await resolveAddress({
            client,
            userId,
            addressId: d.shipping_address_id,
            inline: d.shipping_address,
            region: d.delivery_region,
          })
        : null

    const billingSnapshot = d.billing_same_as_shipping
      ? shippingSnapshot
      : await resolveAddress({
          client,
          userId,
          addressId: d.billing_address_id,
          inline: d.billing_address,
          region: null,
        })

    const fee = deliveryFee(d.delivery_method, d.delivery_region)
    const total = subtotal + fee
    const customerEmail = req.user?.email ?? d.guest_email

    const { rows: orderRows } = await client.query(
      `INSERT INTO orders (
         user_id, guest_email, items, total_lkr, gateway_used,
         customer_first_name, customer_last_name, customer_phone, customer_email,
         delivery_method, delivery_region, delivery_fee_lkr,
         shipping_address, billing_address, save_card_requested, customer_ip
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        userId,
        userId ? null : d.guest_email,
        JSON.stringify(resolvedItems),
        total,
        d.gateway,
        d.first_name,
        d.last_name,
        d.phone,
        customerEmail,
        d.delivery_method,
        d.delivery_method === 'delivery' ? d.delivery_region : null,
        fee,
        shippingSnapshot ? JSON.stringify(shippingSnapshot) : null,
        billingSnapshot ? JSON.stringify(billingSnapshot) : null,
        Boolean(d.save_card && userId && d.gateway === 'dialog_genie'),
        req.ip,
      ]
    )

    const order = orderRows[0]

    // Fraud check runs inside this same transaction so the "past orders"
    // counts it looks at are consistent with the order just inserted
    // above. A rule tripping never blocks the order — it only flags it
    // for a human to glance at.
    const fraudFlags = await evaluateOrderRisk(client, {
      orderId: order.id,
      userId,
      guestEmail: userId ? null : d.guest_email,
      customerEmail,
      totalLkr: total,
      ip: req.ip,
      billingAddress: billingSnapshot,
      billingSameAsShipping: d.billing_same_as_shipping,
      customerFirstName: d.first_name,
      customerLastName: d.last_name,
    })
    if (fraudFlags.length > 0) await recordFraudFlags(client, order.id, fraudFlags)

    await client.query('COMMIT')

    await logBoth(userId, 'order.created', order.id, { total, gateway: d.gateway })

    if (customerEmail) await sendOrderConfirmationEmail(order, customerEmail)
    await sendOrderConfirmationSms(order, d.phone)

    // Notify admins outside the transaction (an email failure should
    // never roll back a real order) — only for flags worth interrupting
    // someone's day over. Low-severity-only flags still show up in the
    // admin panel, just without an email.
    if (fraudFlags.some((f) => f.severity !== 'low')) {
      const superadminEmails = await getSuperadminEmails()
      await Promise.all(superadminEmails.map((email) => sendFraudAlertEmail(order, fraudFlags, email)))
      await logAudit(null, 'fraud.flagged', order.id, { codes: fraudFlags.map((f) => f.code) })
    }

    // Once KOKO_/INTPAY_/DIALOG_GENIE_ env vars are set (project-spec.md
    // Section 4), this calls the real gateway; until then it returns a
    // sandbox mock URL, and the frontend's /payment page simulates the
    // hosted-checkout flow itself via POST /:id/sandbox-pay below.
    const session = await createCheckoutSession(d.gateway, order)

    res.status(201).json({
      order,
      checkout_redirect_url: session.url,
      gateway_live: session.live,
    })
  } catch (err) {
    await client.query('ROLLBACK')
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
    throw err
  } finally {
    client.release()
  }
})

router.get('/mine', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  const { rows } = await query(
    'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  )
  res.json({ orders: rows })
})

// Fetch a single order — used by the payment and thank-you pages after
// checkout. A guest with no session can still view their own order by
// passing the email they checked out with; anyone else gets a 404 rather
// than a 403, so this can't be used to probe which order IDs exist.
router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [req.params.id])
  const order = rows[0]
  if (!order) return res.status(404).json({ error: 'Order not found.' })

  const isOwner = req.user && order.user_id === req.user.id
  const isAdmin = req.user && ['admin', 'superadmin'].includes(req.user.role)
  const isGuestMatch =
    !order.user_id && order.guest_email && req.query.email === order.guest_email

  if (!isOwner && !isAdmin && !isGuestMatch) {
    return res.status(404).json({ error: 'Order not found.' })
  }
  res.json({ order })
})

// Sandbox payment simulation — stands in for the real gateway's hosted
// checkout + webhook until you have live credentials (project-spec.md
// Section 4). Only works while that order's gateway is NOT configured
// with real credentials, so this can never be used to fake-pay a real
// live transaction once you go live.
router.post('/:id/sandbox-pay', async (req, res) => {
  const parsed = z
    .object({
      outcome: z.enum(['success', 'failed']).default('success'),
      card_last4: z.string().length(4).optional(),
      card_brand: z.enum(['visa', 'mastercard']).optional(),
      card_expiry: z.string().optional(),
    })
    .safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [req.params.id])
  const order = rows[0]
  if (!order) return res.status(404).json({ error: 'Order not found.' })

  const isOwner = req.user && order.user_id === req.user.id
  const isGuestMatch = !order.user_id && order.guest_email && req.query.email === order.guest_email
  if (!isOwner && !isGuestMatch) return res.status(404).json({ error: 'Order not found.' })

  const session = await createCheckoutSession(order.gateway_used, order)
  if (session.live) {
    return res
      .status(400)
      .json({ error: 'This gateway has live credentials configured — payment must go through the real checkout, not the sandbox simulator.' })
  }

  const mappedStatus = parsed.data.outcome === 'success' ? 'paid' : 'cancelled'
  const txnId = `sandbox_${Date.now()}`
  const { rows: updated } = await query(
    `UPDATE orders SET status = $1, gateway_txn_id = $2, updated_at = now() WHERE id = $3 RETURNING *`,
    [mappedStatus, txnId, order.id]
  )
  await logAudit(order.user_id, `sandbox_pay.${mappedStatus}`, order.id, { gateway: order.gateway_used })

  // Simulates the gateway's tokenization callback that would normally
  // save a real card token — see project-spec.md Section 0/7: only ever
  // a gateway-issued token + last4 is stored, never a raw card number,
  // and this endpoint never receives one either.
  if (mappedStatus === 'paid' && order.save_card_requested && order.user_id && parsed.data.card_last4) {
    await query(
      `INSERT INTO payment_methods (user_id, gateway, token, brand, last4, expiry)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        order.user_id,
        order.gateway_used,
        `sandbox_tok_${Date.now()}`,
        parsed.data.card_brand ?? null,
        parsed.data.card_last4,
        parsed.data.card_expiry ?? null,
      ]
    )
  }

  if (mappedStatus === 'paid' && order.customer_email) {
    await sendInvoiceEmail(updated[0], order.customer_email, null)
  }

  res.json({ order: updated[0] })
})

// Admin dashboard: list + filter by status/gateway.
router.get('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const { status, gateway } = req.query
  const clauses = []
  const values = []
  if (status) {
    values.push(status)
    clauses.push(`status = $${values.length}`)
  }
  if (gateway) {
    values.push(gateway)
    clauses.push(`gateway_used = $${values.length}`)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const { rows } = await query(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT 200`, values)
  res.json({ orders: rows })
})

router.put('/:id/status', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = z
    .object({ status: z.enum(['pending', 'paid', 'shipped', 'completed', 'cancelled', 'refunded']) })
    .safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid status.' })

  const { rows } = await query(
    `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [parsed.data.status, req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Order not found.' })
  const order = rows[0]
  await logBoth(req.user.id, 'order.status_changed', order.id, { status: parsed.data.status })

  const recipientEmail = order.customer_email ?? (await resolveOrderEmail(order))
  if (recipientEmail) {
    if (order.status === 'shipped') await sendShippingNoticeEmail(order, recipientEmail)
    if (order.status === 'paid') await sendInvoiceEmail(order, recipientEmail, null)
  }

  res.json({ order })
})

async function resolveOrderEmail(order) {
  if (order.guest_email) return order.guest_email
  if (!order.user_id) return null
  const { rows } = await query('SELECT email FROM users WHERE id = $1', [order.user_id])
  return rows[0]?.email ?? null
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export default router
