import { Router } from 'express'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { logBoth } from '../lib/log.js'

const router = Router()

// All routes here already sit behind requireRole('admin','superadmin')
// applied in server.js, plus a couple of superadmin-only ones below.

// ---- Dashboard (Section 8) ----
router.get('/dashboard', async (req, res) => {
  const [revenue, ordersByStatus, upcomingBookings, topProducts, lowStock, gatewaySplit, aov, signups, guestRatio] =
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
  })
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

// ---- Customer account management ----
router.get('/customers', async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, email, disabled, created_at FROM users WHERE role = 'customer' ORDER BY created_at DESC LIMIT 500`
  )
  res.json({ customers: rows })
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
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)
     RETURNING id, name, email, role`,
    [name, email, passwordHash, role]
  )
  await logBoth(req.user.id, 'admin.created', rows[0].id, { role })
  // Spec Section 7 monitoring: alert the super admin when a new admin account is created.
  // TODO: send that alert email here (Resend/SendGrid).
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
  address: z.string().max(300).optional(),
  facebook_url: z.string().url().optional(),
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
