import { Router } from 'express'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { logBoth } from '../lib/log.js'
import { generateProductDescription, translateText } from '../lib/ai.js'
import { sendNewAdminAlertEmail } from '../lib/email.js'
import { getSuperadminEmails } from '../lib/notifications.js'
import { toCsv } from '../lib/csv.js'

const router = Router()

// All routes here already sit behind requireRole('admin','superadmin')
// applied in server.js, plus a couple of superadmin-only ones below.

// ---- Dashboard (Section 8) ----
router.get('/dashboard', async (req, res) => {
  const [revenue, ordersByStatus, upcomingBookings, topProducts, lowStock, gatewaySplit, aov, signups, guestRatio, openFraudFlags, recentFraudFlags, failedAdminLogins, newAdmins] =
    await Promise.all([
      query(`SELECT date_trunc('day', created_at) AS day, SUM(total_lkr) AS revenue
             FROM orders WHERE status IN ('paid','shipped','completed') AND created_at > now() - interval '30 days'
             GROUP BY 1 ORDER BY 1`),
      query(`SELECT status, COUNT(*) FROM orders GROUP BY status`),
      query(`SELECT COUNT(*) FROM bookings WHERE booked_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND status = 'confirmed'`),
      query(`SELECT o.items FROM orders o WHERE o.status IN ('paid','shipped','completed')`),
      query(`SELECT id, name, stock_qty, low_stock_threshold FROM products WHERE is_active = TRUE AND stock_qty <= low_stock_threshold`),
      query(`SELECT gateway_used, COUNT(*) FROM orders WHERE gateway_used IS NOT NULL GROUP BY gateway_used`),
      query(`SELECT AVG(total_lkr) AS aov FROM orders WHERE status IN ('paid','shipped','completed') AND created_at > now() - interval '30 days'`),
      query(`SELECT date_trunc('day', created_at) AS day, COUNT(*) FROM users WHERE role = 'customer' AND created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`),
      query(`SELECT
               COUNT(*) FILTER (WHERE user_id IS NULL) AS guest,
               COUNT(*) FILTER (WHERE user_id IS NOT NULL) AS logged_in
             FROM orders`),
      query(`SELECT COUNT(*)::int AS n FROM fraud_flags WHERE resolved = FALSE`),
      query(`SELECT f.id, f.severity, f.code, f.message, f.created_at, f.order_id
             FROM fraud_flags f WHERE f.resolved = FALSE ORDER BY f.created_at DESC LIMIT 5`),
      // Security widget (Section 8): recent failed logins for admin/superadmin
      // accounts specifically — a failed customer login isn't the same signal.
      query(`SELECT COUNT(*)::int AS n FROM login_attempts la
             JOIN users u ON LOWER(u.email) = LOWER(la.email)
             WHERE la.success = FALSE AND u.role IN ('admin','superadmin')
               AND la.created_at > now() - interval '24 hours'`),
      query(`SELECT COUNT(*)::int AS n FROM users WHERE role IN ('admin','superadmin') AND created_at > now() - interval '7 days'`),
    ])

  // Top products by revenue/units — computed in JS since items live in JSONB.
  const tally = {}
  for (const row of topProducts.rows) {
    for (const item of row.items) {
      if (item.type !== 'product') continue
      tally[item.name] ??= { revenue: 0, units: 0 }
      tally[item.name].revenue += item.unit_price_lkr * item.qty
      tally[item.name].units += item.qty
    }
  }
  const topProductsList = Object.entries(tally)
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)

  res.json({
    revenue_by_day: revenue.rows,
    orders_by_status: ordersByStatus.rows,
    upcoming_bookings_next_7_days: Number(upcomingBookings.rows[0].count),
    top_products: topProductsList,
    low_stock: lowStock.rows,
    gateway_split: gatewaySplit.rows,
    average_order_value_lkr: Number(aov.rows[0].aov ?? 0),
    new_signups_by_day: signups.rows,
    guest_vs_logged_in: guestRatio.rows[0],
    security: {
      open_fraud_flags: openFraudFlags.rows[0].n,
      recent_fraud_flags: recentFraudFlags.rows,
      failed_admin_logins_24h: failedAdminLogins.rows[0].n,
      new_admin_accounts_7d: newAdmins.rows[0].n,
    },
  })
})

// ---- AI-assisted product description (ingredient-based, no web search) ----
const aiDescriptionSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  hint: z.string().max(500).optional(),
})

router.post('/ai/product-description', async (req, res) => {
  const parsed = aiDescriptionSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  try {
    const description = await generateProductDescription(parsed.data)
    await logBoth(req.user.id, 'ai.description_generated', null, { product_name: parsed.data.name })
    res.json({ description })
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message })
  }
})

// ---- AI-assisted translation (Sinhala/Tamil) for any admin text field ----
const aiTranslateSchema = z.object({
  text: z.string().min(1).max(2000),
  targetLang: z.enum(['si', 'ta']),
})

router.post('/ai/translate', async (req, res) => {
  const parsed = aiTranslateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  try {
    const translation = await translateText(parsed.data)
    res.json({ translation })
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message })
  }
})

// ---- Fraud flags (rule-based checks — see src/lib/fraud.js) ----
router.get('/fraud-flags', async (req, res) => {
  const onlyOpen = req.query.status !== 'all'
  const { rows } = await query(
    `SELECT f.*, o.total_lkr, o.customer_email, o.customer_first_name, o.customer_last_name
     FROM fraud_flags f JOIN orders o ON o.id = f.order_id
     ${onlyOpen ? 'WHERE f.resolved = FALSE' : ''}
     ORDER BY f.created_at DESC LIMIT 200`
  )
  res.json({ fraud_flags: rows })
})

router.put('/fraud-flags/:id/resolve', async (req, res) => {
  const { rows } = await query(
    `UPDATE fraud_flags SET resolved = TRUE, resolved_by = $1, resolved_at = now() WHERE id = $2 RETURNING *`,
    [req.user.id, req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Flag not found.' })
  await logBoth(req.user.id, 'fraud.resolved', rows[0].order_id)
  res.json({ fraud_flag: rows[0] })
})

// ---- Logs ----
router.get('/audit-log', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM audit_log WHERE created_at > now() - interval '30 days' ORDER BY created_at DESC LIMIT 500`
  )
  res.json({ audit_log: rows })
})

router.get('/activity-log', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM activity_log WHERE created_at > now() - interval '15 days' ORDER BY created_at DESC LIMIT 200`
  )
  res.json({ activity_log: rows })
})

// Export as a downloadable file — same reasoning as the orders/customers
// exports above: no row cap (the live view above caps at 500/200 rows,
// but export means "give me everything you've still got"), which for
// these two tables just means everything within their existing 30-day
// and 15-day retention windows (logPurge.js already deletes anything
// older, so there's nothing beyond that to export anyway). Joins in the
// actor's name/email rather than leaving a bare UUID in the file.
router.get('/export/audit-log.csv', async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, u.name AS actor_name, u.email AS actor_email
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.created_at > now() - interval '30 days'
     ORDER BY a.created_at DESC`
  )
  const csv = toCsv(rows, [
    { header: 'Timestamp', get: (r) => new Date(r.created_at).toISOString() },
    { header: 'Actor', get: (r) => r.actor_name ?? (r.actor_id ? r.actor_id : 'System') },
    { header: 'Actor Email', get: (r) => r.actor_email },
    { header: 'Action', get: (r) => r.action },
    { header: 'Target', get: (r) => r.target },
    { header: 'Metadata', get: (r) => (r.metadata ? JSON.stringify(r.metadata) : '') },
  ])
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send(csv)
})

router.get('/export/activity-log.csv', async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, u.name AS actor_name, u.email AS actor_email
     FROM activity_log a
     LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.created_at > now() - interval '15 days'
     ORDER BY a.created_at DESC`
  )
  const csv = toCsv(rows, [
    { header: 'Timestamp', get: (r) => new Date(r.created_at).toISOString() },
    { header: 'Actor', get: (r) => r.actor_name ?? (r.actor_id ? r.actor_id : 'System') },
    { header: 'Actor Email', get: (r) => r.actor_email },
    { header: 'Action', get: (r) => r.action },
  ])
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="activity-log-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send(csv)
})

// ---- Customer account management ----
// Expanded per the registration overhaul: shows verification status plus
// order count / total spent / booking count so an admin doesn't have to
// open every customer individually just to see who's actually active.
router.get('/customers', async (req, res) => {
  const { rows } = await query(
    `SELECT
       u.id, u.name, u.first_name, u.last_name, u.email, u.mobile,
       u.email_verified, u.disabled, u.created_at,
       COALESCE(o.order_count, 0) AS order_count,
       COALESCE(o.total_spent_lkr, 0) AS total_spent_lkr,
       COALESCE(b.booking_count, 0) AS booking_count
     FROM users u
     LEFT JOIN (
       SELECT user_id, COUNT(*) AS order_count, SUM(total_lkr) AS total_spent_lkr
       FROM orders WHERE user_id IS NOT NULL GROUP BY user_id
     ) o ON o.user_id = u.id
     LEFT JOIN (
       SELECT user_id, COUNT(*) AS booking_count
       FROM bookings WHERE user_id IS NOT NULL GROUP BY user_id
     ) b ON b.user_id = u.id
     WHERE u.role = 'customer'
     ORDER BY u.created_at DESC LIMIT 500`
  )
  res.json({ customers: rows })
})

// ---- CSV export (accounting/tax records, backups, spreadsheets) ----
// Deliberately no LIMIT here (unlike the paginated /orders and
// /customers listing endpoints above) — an export is supposed to be
// everything, not just the most recent page. Sent as a real file
// download (Content-Disposition: attachment) rather than JSON, so
// clicking the link in the admin panel just saves a .csv straight away.
router.get('/export/orders.csv', async (req, res) => {
  const { rows } = await query(`SELECT * FROM orders ORDER BY created_at DESC`)

  const csv = toCsv(rows, [
    { header: 'Order ID', get: (o) => o.id },
    { header: 'Date', get: (o) => new Date(o.created_at).toISOString() },
    { header: 'Status', get: (o) => o.status },
    { header: 'Customer Name', get: (o) => [o.customer_first_name, o.customer_last_name].filter(Boolean).join(' ') },
    { header: 'Customer Email', get: (o) => o.customer_email ?? o.guest_email },
    { header: 'Customer Phone', get: (o) => o.customer_phone },
    {
      header: 'Items',
      get: (o) => (Array.isArray(o.items) ? o.items.map((i) => `${i.name} x${i.qty}`).join('; ') : ''),
    },
    { header: 'Total (LKR)', get: (o) => o.total_lkr },
    { header: 'Delivery Fee (LKR)', get: (o) => o.delivery_fee_lkr },
    { header: 'Delivery Method', get: (o) => o.delivery_method },
    { header: 'Delivery Region', get: (o) => o.delivery_region },
    { header: 'Payment Gateway', get: (o) => o.gateway_used },
    { header: 'Payment Reference', get: (o) => o.gateway_txn_id },
    {
      header: 'Shipping Address',
      get: (o) => {
        const a = o.shipping_address
        if (!a) return ''
        return [a.line1, a.city, a.postal_code].filter(Boolean).join(', ')
      },
    },
  ])

  await logBoth(req.user.id, 'export.orders_csv', null, { row_count: rows.length })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send(csv)
})

router.get('/export/customers.csv', async (req, res) => {
  const { rows } = await query(
    `SELECT
       u.id, u.name, u.first_name, u.last_name, u.email, u.mobile,
       u.email_verified, u.disabled, u.created_at,
       COALESCE(o.order_count, 0) AS order_count,
       COALESCE(o.total_spent_lkr, 0) AS total_spent_lkr,
       COALESCE(b.booking_count, 0) AS booking_count
     FROM users u
     LEFT JOIN (
       SELECT user_id, COUNT(*) AS order_count, SUM(total_lkr) AS total_spent_lkr
       FROM orders WHERE user_id IS NOT NULL GROUP BY user_id
     ) o ON o.user_id = u.id
     LEFT JOIN (
       SELECT user_id, COUNT(*) AS booking_count
       FROM bookings WHERE user_id IS NOT NULL GROUP BY user_id
     ) b ON b.user_id = u.id
     WHERE u.role = 'customer'
     ORDER BY u.created_at DESC`
  )

  const csv = toCsv(rows, [
    { header: 'Customer ID', get: (c) => c.id },
    { header: 'Name', get: (c) => c.name ?? [c.first_name, c.last_name].filter(Boolean).join(' ') },
    { header: 'Email', get: (c) => c.email },
    { header: 'Mobile', get: (c) => c.mobile },
    { header: 'Email Verified', get: (c) => (c.email_verified ? 'Yes' : 'No') },
    { header: 'Disabled', get: (c) => (c.disabled ? 'Yes' : 'No') },
    { header: 'Joined', get: (c) => new Date(c.created_at).toISOString() },
    { header: 'Order Count', get: (c) => c.order_count },
    { header: 'Total Spent (LKR)', get: (c) => c.total_spent_lkr },
    { header: 'Booking Count', get: (c) => c.booking_count },
  ])

  await logBoth(req.user.id, 'export.customers_csv', null, { row_count: rows.length })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send(csv)
})

// Full detail view for one customer: profile, saved addresses, recent
// orders, recent bookings — everything an admin might need without
// jumping between the Orders/Bookings pages and filtering manually.
router.get('/customers/:id', async (req, res) => {
  const [user, addresses, orders, bookings] = await Promise.all([
    query(
      `SELECT id, name, first_name, last_name, email, mobile, email_verified, disabled, created_at
       FROM users WHERE id = $1 AND role = 'customer'`,
      [req.params.id]
    ),
    query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC', [req.params.id]),
    query(
      `SELECT id, items, total_lkr, status, gateway_used, created_at FROM orders
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    ),
    query(
      `SELECT b.id, b.booked_date, b.booked_time, b.status, s.name AS service_name
       FROM bookings b JOIN services s ON s.id = b.service_id
       WHERE b.user_id = $1 ORDER BY b.booked_date DESC, b.booked_time DESC LIMIT 50`,
      [req.params.id]
    ),
  ])
  if (!user.rows[0]) return res.status(404).json({ error: 'Customer not found.' })

  res.json({
    customer: user.rows[0],
    addresses: addresses.rows,
    orders: orders.rows,
    bookings: bookings.rows,
  })
})

router.put('/customers/:id/disabled', async (req, res) => {
  const parsed = z.object({ disabled: z.boolean() }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'disabled must be boolean.' })

  const { rows } = await query(
    `UPDATE users SET disabled = $1 WHERE id = $2 AND role = 'customer' RETURNING id, disabled`,
    [parsed.data.disabled, req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Customer not found.' })
  await logBoth(req.user.id, parsed.data.disabled ? 'customer.disabled' : 'customer.enabled', rows[0].id)
  res.json({ customer: rows[0] })
})

// ---- Blacklisted emails (registration overhaul) ----
// Blocks specific addresses from ever registering (spam/abuse). Does NOT
// touch any existing account — it only affects future /api/auth/register
// attempts (see auth.routes.js).
router.get('/blacklist', async (req, res) => {
  const { rows } = await query(
    `SELECT b.id, b.email, b.reason, b.created_at, u.name AS created_by_name
     FROM blacklisted_emails b LEFT JOIN users u ON u.id = b.created_by
     ORDER BY b.created_at DESC`
  )
  res.json({ blacklist: rows })
})

const blacklistSchema = z.object({
  email: z.string().email(),
  reason: z.string().max(300).optional(),
})

router.post('/blacklist', async (req, res) => {
  const parsed = blacklistSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const email = parsed.data.email.toLowerCase()

  const existing = await query('SELECT id FROM blacklisted_emails WHERE LOWER(email) = $1', [email])
  if (existing.rows.length) return res.status(409).json({ error: 'That email is already blacklisted.' })

  const { rows } = await query(
    `INSERT INTO blacklisted_emails (email, reason, created_by) VALUES ($1, $2, $3) RETURNING *`,
    [email, parsed.data.reason ?? null, req.user.id]
  )
  await logBoth(req.user.id, 'blacklist.added', rows[0].id, { email })
  res.status(201).json({ entry: rows[0] })
})

router.delete('/blacklist/:id', async (req, res) => {
  await query('DELETE FROM blacklisted_emails WHERE id = $1', [req.params.id])
  await logBoth(req.user.id, 'blacklist.removed', req.params.id)
  res.json({ ok: true })
})

// ---- Admin management (superadmin only) ----
router.get('/admins', requireRole('superadmin'), async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, email, role, is_primary_superadmin, disabled, created_at
     FROM users WHERE role IN ('admin','superadmin') ORDER BY created_at`
  )
  res.json({ admins: rows })
})

const createAdminSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(10),
  role: z.enum(['admin', 'superadmin']),
})

router.post('/admins', requireRole('superadmin'), async (req, res) => {
  const parsed = createAdminSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const { name, email, password, role } = parsed.data

  const existing = await query('SELECT id FROM users WHERE email = $1', [email])
  if (existing.rows.length) return res.status(409).json({ error: 'Email already in use.' })

  const passwordHash = await bcrypt.hash(password, 12)
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ($1,$2,$3,$4,TRUE)
     RETURNING id, name, email, role`,
    [name, email, passwordHash, role]
  )
  await logBoth(req.user.id, 'admin.created', rows[0].id, { role })

  // Spec Section 7 monitoring: alert the super admin when a new admin
  // account is created. Sent outside any transaction (there isn't one
  // here) and never allowed to fail the request — the account is
  // already created at this point, an email hiccup shouldn't undo that
  // or block the response.
  try {
    const superadminEmails = await getSuperadminEmails()
    await Promise.all(
      superadminEmails.map((email) => sendNewAdminAlertEmail(rows[0], req.user.name, email))
    )
  } catch (err) {
    console.error('New-admin alert email failed:', err.message)
  }

  res.status(201).json({ admin: rows[0] })
})

// The primary super admin cannot be deleted — enforced at the DB level
// (see db/schema.sql trigger) as well as here, so the error message is
// friendlier than a raw Postgres exception.
router.delete('/admins/:id', requireRole('superadmin'), async (req, res) => {
  const target = await query('SELECT is_primary_superadmin FROM users WHERE id = $1', [req.params.id])
  if (target.rows[0]?.is_primary_superadmin) {
    return res.status(403).json({ error: 'The primary super admin account cannot be deleted.' })
  }
  await query('DELETE FROM users WHERE id = $1', [req.params.id])
  await logBoth(req.user.id, 'admin.deleted', req.params.id)
  res.json({ ok: true })
})

// ---- Business info (Settings page) ----
// Deliberately limited to non-secret, low-risk fields. API keys, DB
// credentials, and payment gateway secrets are NOT managed here — they
// stay in environment variables on the host, per spec Section 7. If an
// admin login is ever compromised, the blast radius from this endpoint
// is "someone changes the phone number shown on the site", not "someone
// reads out a payment gateway secret."
const businessInfoSchema = z.object({
  phone: z.string().max(50).optional(),
  email: z.string().email().optional(),
  // NOTE: address was removed from here — branches (branches.routes.js)
  // are now the single source of truth for physical addresses, since a
  // business can have more than one location. Any old `address` value
  // already saved in this JSONB blob from before this change is
  // harmless leftover data — it's just no longer read or shown anywhere.
  //
  // Every URL field below uses .optional().or(z.literal('')) rather than
  // just .optional() — .optional() alone only allows the field to be
  // MISSING, not an empty string, so saving the form with a field
  // intentionally left blank would fail validation for the ENTIRE
  // request (a real bug, found and fixed here — facebook_url had this
  // exact issue before this change).
  facebook_url: z.string().url().optional().or(z.literal('')),
  instagram_url: z.string().url().optional().or(z.literal('')),
  tiktok_url: z.string().url().optional().or(z.literal('')),
  linkedin_url: z.string().url().optional().or(z.literal('')),
  // Digits only, with country code, no + or spaces (e.g. "94771234567")
  // — that's the exact format wa.me links need. Validated loosely here;
  // the frontend strips non-digits before saving so a pasted "+94 77
  // 123 4567" still works.
  whatsapp_number: z.string().regex(/^\d{7,15}$/, 'Use digits only, with country code (e.g. 94771234567).').optional().or(z.literal('')),
})

router.get('/settings/business-info', async (req, res) => {
  const { rows } = await query(`SELECT value FROM site_settings WHERE key = 'business_info'`)
  res.json({ business_info: rows[0]?.value ?? {} })
})

router.put('/settings/business-info', async (req, res) => {
  const parsed = businessInfoSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  const current = await query(`SELECT value FROM site_settings WHERE key = 'business_info'`)
  const merged = { ...(current.rows[0]?.value ?? {}), ...parsed.data }

  await query(
    `INSERT INTO site_settings (key, value) VALUES ('business_info', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(merged)]
  )
  await logBoth(req.user.id, 'settings.business_info_updated', null, parsed.data)
  res.json({ business_info: merged })
})

// ---- Booking reminder emails (on/off switch) ----
const bookingRemindersSchema = z.object({
  enabled: z.boolean(),
})

router.get('/settings/booking-reminders', async (req, res) => {
  const { rows } = await query(`SELECT value FROM site_settings WHERE key = 'booking_reminders'`)
  res.json({ booking_reminders: rows[0]?.value ?? { enabled: true } })
})

router.put('/settings/booking-reminders', async (req, res) => {
  const parsed = bookingRemindersSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  await query(
    `INSERT INTO site_settings (key, value) VALUES ('booking_reminders', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(parsed.data)]
  )
  await logBoth(req.user.id, 'settings.booking_reminders_updated', null, parsed.data)
  res.json({ booking_reminders: parsed.data })
})

// ---- Homepage content (basic CMS — Section 2's "Page customization UI") ----
// Same "safe, low-risk fields only" reasoning as business info above:
// this is marketing copy, not anything security-sensitive.
const homepageContentSchema = z.object({
  hero_eyebrow: z.string().max(120).optional(),
  hero_eyebrow_si: z.string().max(120).optional(),
  hero_eyebrow_ta: z.string().max(120).optional(),
  hero_headline: z.string().max(300).optional(),
  hero_headline_si: z.string().max(300).optional(),
  hero_headline_ta: z.string().max(300).optional(),
  hero_subtext: z.string().max(500).optional(),
  hero_subtext_si: z.string().max(500).optional(),
  hero_subtext_ta: z.string().max(500).optional(),
  hero_cta1_label: z.string().max(60).optional(),
  hero_cta1_label_si: z.string().max(60).optional(),
  hero_cta1_label_ta: z.string().max(60).optional(),
  hero_cta2_label: z.string().max(60).optional(),
  hero_cta2_label_si: z.string().max(60).optional(),
  hero_cta2_label_ta: z.string().max(60).optional(),
  // Empty string is a valid value here (it means "clear the override,
  // go back to the bundled default image/video" — see the frontend's
  // fallback logic in Hero.jsx/About.jsx/Products.jsx), so these accept
  // '' as well as a real uploaded URL, unlike a plain z.string().url().
  hero_background_url: z.union([z.string().url(), z.literal('')]).optional(),
  hero_video_url: z.union([z.string().url(), z.literal('')]).optional(),
  about_eyebrow: z.string().max(120).optional(),
  about_eyebrow_si: z.string().max(120).optional(),
  about_eyebrow_ta: z.string().max(120).optional(),
  about_headline: z.string().max(300).optional(),
  about_headline_si: z.string().max(300).optional(),
  about_headline_ta: z.string().max(300).optional(),
  about_paragraph1: z.string().max(1000).optional(),
  about_paragraph1_si: z.string().max(1000).optional(),
  about_paragraph1_ta: z.string().max(1000).optional(),
  about_paragraph2: z.string().max(1000).optional(),
  about_paragraph2_si: z.string().max(1000).optional(),
  about_paragraph2_ta: z.string().max(1000).optional(),
  about_image_url: z.union([z.string().url(), z.literal('')]).optional(),
  about_background_url: z.union([z.string().url(), z.literal('')]).optional(),
  ritual_eyebrow: z.string().max(120).optional(),
  ritual_eyebrow_si: z.string().max(120).optional(),
  ritual_eyebrow_ta: z.string().max(120).optional(),
  ritual_headline: z.string().max(300).optional(),
  ritual_headline_si: z.string().max(300).optional(),
  ritual_headline_ta: z.string().max(300).optional(),
  ritual_subtext: z.string().max(500).optional(),
  ritual_subtext_si: z.string().max(500).optional(),
  ritual_subtext_ta: z.string().max(500).optional(),
  ritual_background_url: z.union([z.string().url(), z.literal('')]).optional(),
  // Up to 9 process-video URLs (shown 3 at a time on the homepage, with
  // paging arrows past that — see RowCarousel.jsx). Capped server-side
  // too, not just in the admin UI, since this is a public-facing
  // section and an unbounded array here would be an easy way to bloat
  // site_settings.
  see_it_made_videos: z.array(z.string().url()).max(9).optional(),
})

router.get('/settings/homepage-content', async (req, res) => {
  const { rows } = await query(`SELECT value FROM site_settings WHERE key = 'homepage_content'`)
  res.json({ homepage_content: rows[0]?.value ?? {} })
})

router.put('/settings/homepage-content', async (req, res) => {
  const parsed = homepageContentSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  const current = await query(`SELECT value FROM site_settings WHERE key = 'homepage_content'`)
  const merged = { ...(current.rows[0]?.value ?? {}), ...parsed.data }

  await query(
    `INSERT INTO site_settings (key, value) VALUES ('homepage_content', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(merged)]
  )
  await logBoth(req.user.id, 'settings.homepage_content_updated', null, parsed.data)
  res.json({ homepage_content: merged })
})

// ---- Maintenance mode & outage calendar (Section 10) ----
router.get('/outages', async (req, res) => {
  const { rows } = await query('SELECT * FROM outage_windows ORDER BY starts_at DESC')
  res.json({ outages: rows })
})

router.post('/outages', async (req, res) => {
  const parsed = z
    .object({
      starts_at: z.string().datetime(),
      ends_at: z.string().datetime(),
      reason: z.string().optional(),
    })
    .safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  const { rows } = await query(
    `INSERT INTO outage_windows (starts_at, ends_at, reason, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [parsed.data.starts_at, parsed.data.ends_at, parsed.data.reason ?? null, req.user.id]
  )
  await logBoth(req.user.id, 'outage.scheduled', rows[0].id)
  res.status(201).json({ outage: rows[0] })
})

// Maintenance mode now requires a schedule to turn ON — an admin picks
// starts_at (required) and optionally ends_at (auto-clears once passed;
// omit it to require a manual Turn Off instead). Turning OFF is always
// instant and needs no schedule — this is the "how do I get back in"
// escape hatch: since /admin and /login always bypass the customer-facing
// placeholder (see the frontend's MaintenanceGate), an admin can log in
// and hit Turn Off at any time, even while the placeholder is showing to
// everyone else.
router.put('/maintenance-mode', async (req, res) => {
  const parsed = z
    .discriminatedUnion('enabled', [
      z.object({
        enabled: z.literal(true),
        starts_at: z.string().datetime(),
        ends_at: z.string().datetime().optional(),
        reason: z.string().optional(),
      }),
      z.object({ enabled: z.literal(false) }),
    ])
    .safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  const value = parsed.data.enabled
    ? {
        enabled: true,
        starts_at: parsed.data.starts_at,
        ends_at: parsed.data.ends_at ?? null,
        reason: parsed.data.reason ?? null,
      }
    : { enabled: false }

  await query(`UPDATE site_settings SET value = $1 WHERE key = 'maintenance_mode'`, [JSON.stringify(value)])
  await logBoth(req.user.id, parsed.data.enabled ? 'maintenance.scheduled' : 'maintenance.disabled')
  res.json({ maintenance_schedule: value })
})

export default router
