import { Router } from 'express'
import { z } from 'zod'
import { query, pool } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { logBoth, logAudit } from '../lib/log.js'
import { sendOrderConfirmationEmail, sendShippingNoticeEmail, sendInvoiceEmail, sendFraudAlertEmail, sendRefundRequestReceivedEmail, sendRefundRequestResolvedEmail } from '../lib/email.js'
import { sendOrderConfirmationSms } from '../lib/sms.js'
import { createCheckoutSession, isConfigured, refundPayment, GATEWAYS } from '../lib/gateways.js'
import { deliveryFee, isValidRegion } from '../lib/delivery.js'
import { evaluateOrderRisk, recordFraudFlags } from '../lib/fraud.js'
import { getSuperadminEmails } from '../lib/notifications.js'
import { maybeSendLowStockAlert } from '../lib/lowStockAlert.js'
import { generateInvoicePdf } from '../lib/pdf.js'
import { storePdf } from '../lib/uploads.js'

// "What's stubbed" (SETUP-AND-DEPLOYMENT.md 4.1): "PDF invoices — the
// invoices table and an invoice email exist, but nothing generates an
// actual PDF file yet." This is that missing piece. Returns the
// existing invoice's URL if one was already generated for this order
// (so re-visiting the thank-you page or clicking "Download Invoice"
// twice doesn't render + upload a fresh PDF every time), otherwise
// generates one, stores it, and records it in the `invoices` table.
async function ensureInvoice(order) {
  const existing = await query('SELECT pdf_url FROM invoices WHERE order_id = $1', [order.id])
  // Re-generate rather than reuse if the stored URL doesn't actually end
  // in .pdf — a handful of invoices generated before the Cloudinary
  // raw-upload extension fix (see storeBuffer in lib/uploads.js) have
  // this exact broken shape cached in the table already; this makes
  // them self-heal the next time anyone downloads that invoice, rather
  // than needing a manual DB fix.
  if (existing.rows[0]?.pdf_url?.toLowerCase().endsWith('.pdf')) return existing.rows[0].pdf_url

  const buffer = await generateInvoicePdf(order)
  const pdfUrl = await storePdf(buffer)
  if (existing.rows[0]) {
    await query('UPDATE invoices SET pdf_url = $1, issued_at = now() WHERE order_id = $2', [pdfUrl, order.id])
  } else {
    await query('INSERT INTO invoices (order_id, pdf_url) VALUES ($1, $2)', [order.id, pdfUrl])
  }
  return pdfUrl
}

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
  // Fails fast, before creating anything, if the chosen gateway has no
  // live credentials AND this is a real production deployment with
  // sandbox payments not deliberately enabled (see the matching check
  // in POST /:id/sandbox-pay for the full reasoning) — otherwise the
  // customer would fill in their entire address and card details only
  // to hit a wall on the very last click.
  const sandboxBlockedInProd = process.env.NODE_ENV === 'production' && process.env.ENABLE_SANDBOX_IN_PRODUCTION !== 'true'
  if (sandboxBlockedInProd && !isConfigured(d.gateway)) {
    return res.status(400).json({ error: 'This payment method is not available yet. Please choose a different one.' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const resolvedItems = []
    const stockCrossingChecks = [] // resolved after COMMIT — see below
    let subtotal = 0

    for (const item of d.items) {
      const table = item.type === 'product' ? 'products' : 'services'
      const { rows } = await client.query(
        `SELECT id, name, price_lkr${
          item.type === 'product' ? ', stock_qty, low_stock_threshold, availability_mode, preorder_eta_days' : ''
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
          stockCrossingChecks.push({
            id: record.id,
            name: record.name,
            previousQty: record.stock_qty,
            newQty: record.stock_qty - item.qty,
            threshold: record.low_stock_threshold,
          })
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

    // Same "outside the transaction, never blocks the order" reasoning
    // as the fraud alert above — and maybeSendLowStockAlert itself only
    // actually emails on a genuine crossing (see lib/lowStockAlert.js),
    // so most orders call this and it silently does nothing.
    await Promise.all(stockCrossingChecks.map((c) => maybeSendLowStockAlert(c))).catch((err) =>
      console.error('[low-stock-alert] failed:', err.message)
    )

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
// ---- Cancellation & return/refund requests ----
//
// A request never changes order.status by itself — only an admin
// approving one does (see PUT /api/admin/refund-requests/:id below).
// That's a deliberate choice: this system has no live payment gateway
// yet (see lib/gateways.js), so there's no way to *guarantee* an
// automatic refund actually happened — a human confirms it, the same
// way the project already treats bookings ("admin-initiated at
// minimum," per project-spec.md Section 2).
//
// Cancellation: allowed any time before the order has actually reached
// the customer — which for a pickup order means "not yet collected,"
// not "not yet marked ready," since nothing has changed hands yet even
// once it's sitting on the shelf waiting.
function cancellationEligible(order) {
  if (['pending', 'paid'].includes(order.status)) return true
  if (order.status === 'shipped' && order.delivery_method === 'pickup') return true
  return false
}

// Return/refund: only after the order is actually done (delivered or
// collected), and only within a fixed window afterward — adjustable by
// admins (Settings → Order Policies) rather than hardcoded, since 14
// days won't fit every business. There's no dedicated "completed_at"
// timestamp column, so this uses updated_at as the closest available
// proxy for "when it was marked completed" — true as long as nothing
// else touches an order after that point, which matches how the admin
// status flow actually works today.
const DEFAULT_RETURN_WINDOW_DAYS = 14
async function getReturnWindowDays() {
  const { rows } = await query(`SELECT value FROM site_settings WHERE key = 'order_policies'`)
  const days = rows[0]?.value?.return_window_days
  return Number.isFinite(days) ? days : DEFAULT_RETURN_WINDOW_DAYS
}
async function returnEligible(order) {
  if (order.status !== 'completed') return false
  const windowDays = await getReturnWindowDays()
  const daysSinceCompleted = (Date.now() - new Date(order.updated_at).getTime()) / 86400000
  return daysSinceCompleted <= windowDays
}

// Same ownership rule GET /:id and GET /:id/invoice already use,
// pulled out so the two request endpoints below don't need a third
// copy of it. Writes the 404-or-null response itself so call sites can
// just `if (!order) return`.
async function loadAccessibleOrder(req, res) {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [req.params.id])
  const order = rows[0]
  if (!order) {
    res.status(404).json({ error: 'Order not found.' })
    return null
  }
  const isOwner = req.user && order.user_id === req.user.id
  const isAdmin = req.user && ['admin', 'superadmin'].includes(req.user.role)
  const isGuestMatch = !order.user_id && order.guest_email && req.query.email === order.guest_email
  if (!isOwner && !isAdmin && !isGuestMatch) {
    res.status(404).json({ error: 'Order not found.' })
    return null
  }
  return order
}

const refundRequestSchema = z.object({ reason: z.string().min(1, 'Please tell us why.').max(1000) })

async function createRefundRequest(req, res, type, eligible, ineligibleMessage) {
  const parsed = refundRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  const order = await loadAccessibleOrder(req, res)
  if (!order) return

  // ineligibleMessage can be a plain string or a function returning one
  // (async or not) — return-request needs the current admin-configured
  // window baked into its message, which a static string can't do.
  if (!(await eligible(order))) {
    const message = typeof ineligibleMessage === 'function' ? await ineligibleMessage() : ineligibleMessage
    return res.status(400).json({ error: message })
  }

  const existing = await query(`SELECT id FROM refund_requests WHERE order_id = $1 AND status = 'pending'`, [order.id])
  if (existing.rows[0]) {
    return res.status(409).json({ error: 'A request for this order is already pending review.' })
  }

  // customer_email is always populated at order-creation time (either
  // the logged-in user's email or the guest's) — see the INSERT in
  // POST / above — so this never actually needs the guest_email
  // fallback in practice; kept only as a defensive fallback for any
  // pre-existing order where that assumption somehow doesn't hold.
  const email = order.customer_email || order.guest_email
  let request
  try {
    const { rows } = await query(
      `INSERT INTO refund_requests (order_id, type, reason, requested_by_user_id, requested_by_email)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [order.id, type, parsed.data.reason, req.user?.id ?? null, email]
    )
    request = rows[0]
  } catch (err) {
    // 23505 = unique_violation on idx_refund_requests_one_pending_per_order
    // — the SELECT check above already covers the common case, but a
    // second submit within the same instant (double-click, or the
    // request retrying after a dropped connection) can still race past
    // it; the database constraint is the real backstop, this just turns
    // that into the same friendly message instead of a raw 500.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A request for this order is already pending review.' })
    }
    throw err
  }

  await logBoth(req.user?.id ?? null, `refund_request.${type}`, order.id, { reason: parsed.data.reason })

  // Best-effort — a delivery hiccup on this notification shouldn't fail
  // the customer's request itself; the request is already saved and
  // will show up in Admin → Refund Requests regardless.
  try {
    const admins = await getSuperadminEmails()
    await Promise.all(admins.map((toEmail) => sendRefundRequestReceivedEmail(order, request, toEmail)))
  } catch (err) {
    console.error('[refund-request] admin notification failed:', err.message)
  }

  res.status(201).json({ refund_request: request })
}

router.post('/:id/cancel-request', (req, res) =>
  createRefundRequest(
    req,
    res,
    'cancellation',
    async (order) => cancellationEligible(order),
    'This order can no longer be cancelled online — please contact us instead.'
  )
)

router.post('/:id/return-request', (req, res) =>
  createRefundRequest(
    req,
    res,
    'return',
    returnEligible,
    async () => `Returns are only available within ${await getReturnWindowDays()} days of an order being completed.`
  )
)

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

  // The most recent request (of either type) for this order, if any —
  // lets the customer's order page show "cancellation pending review" /
  // "return approved" etc. without a second request. can_cancel/
  // can_return are computed here (not left for the frontend to guess
  // at) so the eligibility rule only lives in one place — see
  // cancellationEligible/returnEligible below.
  const { rows: requestRows } = await query(
    'SELECT * FROM refund_requests WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
    [order.id]
  )
  const existingRequest = requestRows[0] || null
  const hasPendingRequest = existingRequest?.status === 'pending'

  res.json({
    order: {
      ...order,
      refund_request: existingRequest,
      can_cancel: !hasPendingRequest && cancellationEligible(order),
      can_return: !hasPendingRequest && (await returnEligible(order)),
    },
  })
})

// On-demand invoice PDF (spec Section 2: "Invoice generation (PDF, auto
// or on-demand)"). Same ownership rule as GET /:id above — a guest
// passes ?email=, a logged-in customer just needs to own the order, and
// admins can pull any order's invoice. Redirects straight to the PDF's
// URL (Cloudinary or this server's own /uploads) rather than proxying
// the file through this route.
router.get('/:id/invoice', async (req, res) => {
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
  if (order.status === 'pending') {
    return res.status(400).json({ error: 'An invoice is only available once the order is paid.' })
  }

  const pdfUrl = await ensureInvoice(order)
  res.redirect(pdfUrl)
})

// Sandbox payment simulation — stands in for the real gateway's hosted
// checkout + webhook until you have live credentials (project-spec.md
// Section 4). Only works while that order's gateway is NOT configured
// with real credentials, so this can never be used to fake-pay a real
// live transaction once you go live.
router.post('/:id/sandbox-pay', async (req, res) => {
  // Blocks this endpoint on a real production deployment by default —
  // the only existing guard below (`session.live`) only fires once a
  // *specific* gateway has live credentials configured, which means as
  // long as none of Koko/IntPay/Dialog Genie are live yet, this endpoint
  // stays wide open on the real public site: anyone can "pay" for a
  // real order without any money changing hands. That's exactly the
  // gap this closes. Set ENABLE_SANDBOX_IN_PRODUCTION=true as a
  // deliberate, temporary opt-in if you need to demo a full purchase
  // flow on the live URL before any gateway is ready — remove it again
  // before actually announcing the site.
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_SANDBOX_IN_PRODUCTION !== 'true') {
    return res.status(403).json({ error: 'Sandbox payments are disabled in production.' })
  }

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
    // A PDF failure (e.g. a transient storage hiccup) should never block
    // the payment response — the order is already marked paid above.
    // The invoice can still be generated later, on demand, via
    // GET /:id/invoice.
    let pdfUrl = null
    try {
      pdfUrl = await ensureInvoice(updated[0])
    } catch (err) {
      console.error('Invoice PDF generation failed:', err.message)
    }
    await sendInvoiceEmail(updated[0], order.customer_email, pdfUrl)
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
    if (order.status === 'paid') {
      let pdfUrl = null
      try {
        pdfUrl = await ensureInvoice(order)
      } catch (err) {
        console.error('Invoice PDF generation failed:', err.message)
      }
      await sendInvoiceEmail(order, recipientEmail, pdfUrl)
    }
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
