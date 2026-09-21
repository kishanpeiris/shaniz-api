import { Router } from 'express'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { query, pool } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'
import { logBoth, logActivity } from '../lib/log.js'
import { serializeUser } from '../lib/serializeUser.js'
import { clearSessionCookie } from '../lib/session.js'
import { OPTIONAL_EMAIL_TYPES, ALWAYS_SENT_EMAILS, suppressedTypes, setSuppressed } from '../lib/emailPrefs.js'

const router = Router()

// Everything in this file requires a logged-in customer (or admin/superadmin,
// since admins are also users with addresses/orders of their own).
router.use(requireAuth)

// ---- Profile ----
router.get('/profile', async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, first_name, last_name, email, mobile, role, email_verified, language_pref, disabled, created_at
     FROM users WHERE id = $1`,
    [req.user.id]
  )
  res.json({ user: serializeUser(rows[0]) })
})

// lastName stays optional (mononym-friendly). When either name field
// changes, `name` (the single combined display name used everywhere
// else in the app) is recomputed to match.
const profileSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100).optional(),
  mobile: z.string().min(7).max(20).optional().or(z.literal('')),
})

router.put('/profile', async (req, res) => {
  const parsed = profileSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const { firstName, lastName, mobile } = parsed.data
  const name = lastName ? `${firstName} ${lastName}` : firstName

  const { rows } = await query(
    `UPDATE users SET name = $1, first_name = $2, last_name = $3, mobile = $4
     WHERE id = $5
     RETURNING id, name, first_name, last_name, email, mobile, role, email_verified, language_pref, disabled, created_at`,
    [name, firstName, lastName || null, mobile || null, req.user.id]
  )
  await logActivity(req.user.id, 'account.profile_updated')
  res.json({ user: serializeUser(rows[0]) })
})

// Change password while logged in (different flow from forgot/reset-password,
// which is for when the user is locked out).
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(10, 'Password must be at least 10 characters.')
    .regex(/[A-Z]/, 'Password needs at least one uppercase letter.')
    .regex(/[0-9]/, 'Password needs at least one number.'),
})

// Language preference — a customer's own choice for the storefront
// (English by default, or Sinhala/Tamil). Kept as its own tiny endpoint
// rather than folded into PUT /profile since it has nothing to do with
// name/mobile and shouldn't require re-sending those every time someone
// just wants to switch languages.
router.put('/language', async (req, res) => {
  const parsed = z.object({ languagePref: z.enum(['en', 'si', 'ta']) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'languagePref must be en, si, or ta.' })

  await query('UPDATE users SET language_pref = $1 WHERE id = $2', [parsed.data.languagePref, req.user.id])
  await logActivity(req.user.id, 'account.language_updated')
  res.json({ languagePref: parsed.data.languagePref })
})

router.put('/password', async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])
  const valid = await bcrypt.compare(parsed.data.currentPassword, rows[0].password_hash)
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' })

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12)
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, req.user.id])
  await logBoth(req.user.id, 'account.password_changed')
  res.json({ ok: true })
})

// ---- Addresses ----
router.get('/addresses', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  )
  res.json({ addresses: rows })
})

const addressSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  line1: z.string().min(1),
  city: z.string().min(1),
  postal_code: z.string().optional(),
  phone: z.string().optional(),
  region: z.enum(['colombo_main', 'colombo_suburbs', 'outer_suburbs', 'outside_colombo']).optional(),
  address_type: z.enum(['shipping', 'billing']).optional().default('shipping'),
})

router.post('/addresses', async (req, res) => {
  const parsed = addressSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const a = parsed.data
  const { rows } = await query(
    `INSERT INTO addresses (user_id, first_name, last_name, line1, city, postal_code, phone, region, address_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [req.user.id, a.first_name ?? null, a.last_name ?? null, a.line1, a.city, a.postal_code ?? null, a.phone ?? null, a.region ?? null, a.address_type]
  )
  await logActivity(req.user.id, 'account.address_added')
  res.status(201).json({ address: rows[0] })
})

router.put('/addresses/:id', async (req, res) => {
  const parsed = addressSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const fields = parsed.data
  const keys = Object.keys(fields)
  if (keys.length === 0) return res.status(400).json({ error: 'No fields to update.' })

  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
  const values = keys.map((k) => fields[k])
  const { rows } = await query(
    `UPDATE addresses SET ${setClause} WHERE id = $${keys.length + 1} AND user_id = $${
      keys.length + 2
    } RETURNING *`,
    [...values, req.params.id, req.user.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Address not found.' })
  res.json({ address: rows[0] })
})

router.delete('/addresses/:id', async (req, res) => {
  await query('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])
  await logActivity(req.user.id, 'account.address_removed')
  res.json({ ok: true })
})

// ---- Saved payment methods ----
// Per spec Section 0/7: only ever store a gateway-issued token + last4,
// never raw card data. Tokens are created by the gateway's hosted
// checkout/tokenization flow (see src/lib/gateways.js) and saved here
// once that flow redirects back with a token — there is no endpoint that
// accepts a raw card number, on purpose.
router.get('/payment-methods', async (req, res) => {
  const { rows } = await query(
    'SELECT id, gateway, brand, last4, expiry, created_at FROM payment_methods WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  )
  res.json({ payment_methods: rows })
})

router.delete('/payment-methods/:id', async (req, res) => {
  await query('DELETE FROM payment_methods WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ])
  await logActivity(req.user.id, 'account.payment_method_removed')
  res.json({ ok: true })
})
// ---- Bookings for "my account" ----
router.get('/bookings', async (req, res) => {
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name, br.name AS branch_name, br.address AS branch_address
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     LEFT JOIN branches br ON br.id = b.branch_id
     WHERE b.user_id = $1 AND b.status IN ('confirmed', 'completed', 'cancelled')
       AND NOT (b.status = 'cancelled' AND b.order_id IS NULL)
     ORDER BY b.booked_date DESC, b.booked_time DESC`,
    [req.user.id]
  )
  res.json({ bookings: rows })
})

// ---- Saved basket ("logging in will save their basket") ----
router.get('/cart', async (req, res) => {
  const { rows } = await query('SELECT items, updated_at FROM saved_carts WHERE user_id = $1', [
    req.user.id,
  ])
  res.json({ cart: rows[0] ?? { items: [], updated_at: null } })
})

const cartSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.enum(['product', 'service']),
      name: z.string(),
      price: z.number(),
      qty: z.number().int().positive(),
    })
  ),
})

router.put('/cart', async (req, res) => {
  const parsed = cartSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  await query(
    // The basket is re-saved whenever a signed-in customer visits the site, so
    // the 72-hour reminder clock (and the "already reminded" flag) restart
    // ONLY when the basket contents actually changed — not on a plain visit.
    `INSERT INTO saved_carts (user_id, items, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET
       items            = $2::jsonb,
       updated_at       = CASE WHEN saved_carts.items IS DISTINCT FROM $2::jsonb THEN now() ELSE saved_carts.updated_at END,
       last_reminder_at = CASE WHEN saved_carts.items IS DISTINCT FROM $2::jsonb THEN NULL ELSE saved_carts.last_reminder_at END,
       reminders_sent   = CASE WHEN saved_carts.items IS DISTINCT FROM $2::jsonb THEN 0 ELSE saved_carts.reminders_sent END`,
    [req.user.id, JSON.stringify(parsed.data.items)]
  )
  res.json({ ok: true })
})

// ---- Your data: download a copy / delete the account ----
// Privacy rights (access + erasure). The export never includes the password
// hash or payment tokens — only what is useful to the person themselves.
router.get('/export', async (req, res) => {
  const id = req.user.id
  const [profile, addresses, cards, orders, bookings, reviews, cart, off] = await Promise.all([
    query('SELECT name, first_name, last_name, email, mobile, language_pref, created_at FROM users WHERE id = $1', [id]),
    query('SELECT first_name, last_name, line1, city, postal_code, region, phone, address_type FROM addresses WHERE user_id = $1', [id]),
    query('SELECT gateway, brand, last4, expiry, created_at FROM payment_methods WHERE user_id = $1', [id]),
    query(
      `SELECT id, created_at, status, items, total_lkr, delivery_method, delivery_fee_lkr, gateway_used,
              shipping_address, billing_address FROM orders WHERE user_id = $1 ORDER BY created_at DESC`,
      [id]
    ),
    query(
      `SELECT b.booked_date, b.booked_time, b.status, s.name AS service, br.name AS branch, b.guest_mobile, b.guest_home_phone
       FROM bookings b JOIN services s ON s.id = b.service_id LEFT JOIN branches br ON br.id = b.branch_id
       WHERE b.user_id = $1 AND b.status != 'held' ORDER BY b.booked_date DESC`,
      [id]
    ),
    query('SELECT rating, title, comment, created_at FROM reviews WHERE user_id = $1', [id]),
    query('SELECT items, updated_at FROM saved_carts WHERE user_id = $1', [id]),
    suppressedTypes(req.user.email),
  ])
  const data = {
    exported_at: new Date().toISOString(),
    profile: profile.rows[0],
    addresses: addresses.rows,
    saved_cards_masked: cards.rows,
    orders: orders.rows,
    bookings: bookings.rows,
    reviews: reviews.rows,
    saved_basket: cart.rows[0] ?? null,
    emails_switched_off: [...off],
  }
  await logActivity(id, 'account.data_exported')
  res.setHeader('Content-Disposition', 'attachment; filename="my-shaniz-data.json"')
  res.json(data)
})

// Deleting an account removes the profile, addresses, saved cards, basket
// and reviews. Order and booking records are KEPT (tax/accounting law
// requires businesses to keep sales records) but stripped of personal
// details. Refused while an order is still being processed or a booking
// is coming up, so nothing in flight is left without a contact.
router.delete('/', async (req, res) => {
  const parsed = z.object({ password: z.string().min(1) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Please enter your password to confirm.' })
  if (req.user.role !== 'customer') {
    return res.status(403).json({ error: 'Staff accounts are removed by a super admin under Admin → Admins.' })
  }

  const { rows: u } = await query('SELECT password_hash, email FROM users WHERE id = $1', [req.user.id])
  if (!(await bcrypt.compare(parsed.data.password, u[0].password_hash))) {
    return res.status(400).json({ error: 'That password is not correct.' })
  }

  const open = await query(
    `SELECT
       (SELECT COUNT(*) FROM orders WHERE user_id = $1 AND status IN ('pending', 'paid', 'shipped')) AS orders_open,
       (SELECT COUNT(*) FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND booked_date >= CURRENT_DATE) AS bookings_open`,
    [req.user.id]
  )
  if (Number(open.rows[0].orders_open) > 0 || Number(open.rows[0].bookings_open) > 0) {
    return res.status(409).json({
      error: 'You have an order in progress or an upcoming booking. Please try again once those are complete, or contact us and we will help.',
    })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE orders SET shipping_address_id = NULL WHERE user_id = $1', [req.user.id])
    await client.query(
      `UPDATE orders SET customer_first_name = 'Deleted', customer_last_name = 'customer', customer_phone = NULL,
         customer_email = 'deleted@deleted.invalid', guest_email = 'deleted@deleted.invalid',
         shipping_address = NULL, billing_address = NULL, customer_ip = NULL
       WHERE user_id = $1`,
      [req.user.id]
    )
    await client.query(
      `UPDATE bookings SET guest_name = NULL, guest_email = NULL, guest_mobile = NULL, guest_home_phone = NULL
       WHERE user_id = $1`,
      [req.user.id]
    )
    await client.query('DELETE FROM email_suppressions WHERE email = $1', [u[0].email.toLowerCase()])
    await client.query('DELETE FROM users WHERE id = $1', [req.user.id]) // cascades addresses, cards, basket, reviews
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  await logBoth(null, 'account.self_deleted', null, {})
  clearSessionCookie(res)
  res.json({ ok: true })
})

// ---- Email notification preferences ----
// Only the optional emails can be switched off; the always-sent ones are
// listed so the customer can see what they will keep receiving.
router.get('/email-prefs', async (req, res) => {
  const off = await suppressedTypes(req.user.email)
  res.json({
    optional: Object.entries(OPTIONAL_EMAIL_TYPES).map(([type, meta]) => ({
      type,
      label: meta.label,
      description: meta.description,
      enabled: !off.has(type),
    })),
    alwaysSent: ALWAYS_SENT_EMAILS,
  })
})

router.put('/email-prefs', async (req, res) => {
  const parsed = z.object({ type: z.string(), enabled: z.boolean() }).safeParse(req.body)
  if (!parsed.success || !OPTIONAL_EMAIL_TYPES[parsed.data.type]) {
    return res.status(400).json({ error: 'Unknown email type.' })
  }
  await setSuppressed(req.user.email, parsed.data.type, !parsed.data.enabled)
  res.json({ ok: true })
})

export default router
