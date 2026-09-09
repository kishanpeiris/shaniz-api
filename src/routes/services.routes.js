import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { logBoth } from '../lib/log.js'

const router = Router()

// Same "units sold" approach as products.routes.js — see the comment
// there. Purchasable and bookable services both create an order (a
// booking's order_id points back to one), so this single query covers
// both service types.
const UNITS_SOLD_SUBQUERY = `
  LEFT JOIN (
    SELECT (item->>'id')::uuid AS service_id, SUM(COALESCE((item->>'qty')::int, 0)) AS qty
    FROM orders o, jsonb_array_elements(o.items) AS item
    WHERE o.status IN ('paid', 'shipped', 'completed') AND item->>'type' = 'service'
    GROUP BY (item->>'id')::uuid
  ) sold ON sold.service_id = s.id
`

router.get('/', async (req, res) => {
  const isAdmin = req.user && ['admin', 'superadmin'].includes(req.user.role)
  const includeInactive = isAdmin && req.query.all === 'true'
  const { rows } = await query(
    `SELECT s.id, s.name, s.description, s.price_lkr, s.service_type, s.duration_minutes, s.images,
            s.hover_video_url, s.hover_webp_url, s.hover_gif_url, s.detail_video_url, s.is_active, s.branch_id,
            s.category_id, c.name AS category, c.parent_id AS category_parent_id, s.badges,
            s.image_focal_x, s.image_focal_y,
            b.name AS branch_name, b.address AS branch_address, b.latitude AS branch_latitude,
            b.longitude AS branch_longitude, b.phone AS branch_phone,
            COALESCE(sold.qty, 0)::int AS units_sold
     FROM services s
     LEFT JOIN branches b ON b.id = s.branch_id
     LEFT JOIN categories c ON c.id = s.category_id
     ${UNITS_SOLD_SUBQUERY}
     ${includeInactive ? '' : 'WHERE s.is_active = TRUE'}
     ORDER BY s.created_at DESC`
  )
  res.json({ services: rows })
})

// Public detail view — same shape as GET /api/products/:id, used by the
// new ServiceDetailPage.
router.get('/:id', async (req, res) => {
  const isAdmin = req.user && ['admin', 'superadmin'].includes(req.user.role)
  const { rows } = await query(
    `SELECT s.*, b.name AS branch_name, b.address AS branch_address, b.latitude AS branch_latitude,
            b.longitude AS branch_longitude, b.phone AS branch_phone, c.name AS category, c.parent_id AS category_parent_id
     FROM services s
     LEFT JOIN branches b ON b.id = s.branch_id
     LEFT JOIN categories c ON c.id = s.category_id
     WHERE s.id = $1 ${isAdmin ? '' : 'AND s.is_active = TRUE'}`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Service not found.' })
  res.json({ service: rows[0] })
})

const serviceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  price_lkr: z.number().nonnegative(),
  service_type: z.enum(['bookable', 'purchasable']),
  duration_minutes: z.number().int().positive().optional(),
  category_id: z.string().uuid().nullable().optional(),
  badges: z.array(z.string().min(1).max(40)).max(6).optional(),
  images: z.array(z.string().url()).optional(),
  // Same hover-preference order as products: video, then webp, then the
  // legacy gif field, then just the first image in `images`.
  hover_video_url: z.string().url().optional(),
  hover_webp_url: z.string().url().optional(),
  hover_gif_url: z.string().url().optional(),
  detail_video_url: z.string().url().nullable().optional(),
  image_focal_x: z.number().min(0).max(100).optional(),
  image_focal_y: z.number().min(0).max(100).optional(),
  branch_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
})

router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = serviceSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const s = parsed.data
  if (s.service_type === 'bookable' && !s.duration_minutes) {
    return res.status(400).json({ error: 'duration_minutes is required for bookable services.' })
  }

  const { rows } = await query(
    `INSERT INTO services (name, description, price_lkr, service_type, duration_minutes, category_id, badges, images, hover_video_url, hover_webp_url, hover_gif_url, detail_video_url, branch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      s.name,
      s.description ?? null,
      s.price_lkr,
      s.service_type,
      s.duration_minutes ?? null,
      s.category_id ?? null,
      s.badges ?? [],
      s.images ?? [],
      s.hover_video_url ?? null,
      s.hover_webp_url ?? null,
      s.hover_gif_url ?? null,
      s.detail_video_url ?? null,
      s.branch_id ?? null,
    ]
  )
  await logBoth(req.user.id, 'service.created', rows[0].id)
  res.status(201).json({ service: rows[0] })
})

router.put('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = serviceSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const fields = parsed.data
  const keys = Object.keys(fields)
  if (keys.length === 0) return res.status(400).json({ error: 'No fields to update.' })

  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
  const values = keys.map((k) => fields[k])
  const { rows } = await query(
    `UPDATE services SET ${setClause}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`,
    [...values, req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Service not found.' })
  await logBoth(req.user.id, 'service.updated', rows[0].id, fields)
  res.json({ service: rows[0] })
})

// Soft delete (deactivate) — see the matching comment in
// products.routes.js. Bookings referencing this service are untouched.
router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  await query('UPDATE services SET is_active = FALSE WHERE id = $1', [req.params.id])
  await logBoth(req.user.id, 'service.deactivated', req.params.id)
  res.json({ ok: true })
})

// True, permanent delete — only once already deactivated (same
// two-step safeguard as products). Unlike products, a service CAN have
// real foreign-key dependents: `bookings.service_id` has no cascade, so
// the database itself will refuse this delete if any booking (past or
// future) references the service. That's surfaced here as a friendly
// message instead of a raw 500, since it's an expected, common case
// (any service that's ever actually been booked) rather than a bug.
router.delete('/:id/permanent', requireRole('admin', 'superadmin'), async (req, res) => {
  const { rows } = await query('SELECT is_active FROM services WHERE id = $1', [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Service not found.' })
  if (rows[0].is_active) {
    return res.status(400).json({ error: 'Deactivate this service first, then permanently delete it.' })
  }
  try {
    await query('DELETE FROM services WHERE id = $1', [req.params.id])
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({
        error: 'This service has existing bookings on record and can\u2019t be permanently deleted — it will stay deactivated so booking history is preserved.',
      })
    }
    throw err
  }
  await logBoth(req.user.id, 'service.deleted', req.params.id)
  res.json({ ok: true })
})

// ---- Admin: weekly availability windows ----
router.get('/:id/availability', requireRole('admin', 'superadmin'), async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM service_availability WHERE service_id = $1 ORDER BY day_of_week, start_time`,
    [req.params.id]
  )
  res.json({ windows: rows })
})

const availabilitySchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
})

router.post('/:id/availability', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = availabilitySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const { day_of_week, start_time, end_time } = parsed.data

  const { rows } = await query(
    `INSERT INTO service_availability (service_id, day_of_week, start_time, end_time)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params.id, day_of_week, start_time, end_time]
  )
  await logBoth(req.user.id, 'service.availability_added', req.params.id, parsed.data)
  res.status(201).json({ window: rows[0] })
})

router.delete('/:id/availability/:windowId', requireRole('admin', 'superadmin'), async (req, res) => {
  await query('DELETE FROM service_availability WHERE id = $1 AND service_id = $2', [
    req.params.windowId,
    req.params.id,
  ])
  await logBoth(req.user.id, 'service.availability_removed', req.params.windowId)
  res.json({ ok: true })
})

// ---- Admin: blackout days (days off) ----
router.get('/:id/blackouts', requireRole('admin', 'superadmin'), async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM service_blackouts WHERE service_id = $1 ORDER BY blackout_date`,
    [req.params.id]
  )
  res.json({ blackouts: rows })
})

router.post('/:id/blackouts', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = z
    .object({ blackout_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().optional() })
    .safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  const { rows } = await query(
    `INSERT INTO service_blackouts (service_id, blackout_date, reason) VALUES ($1,$2,$3) RETURNING *`,
    [req.params.id, parsed.data.blackout_date, parsed.data.reason ?? null]
  )
  await logBoth(req.user.id, 'service.blackout_added', req.params.id, parsed.data)
  res.status(201).json({ blackout: rows[0] })
})

router.delete('/:id/blackouts/:blackoutId', requireRole('admin', 'superadmin'), async (req, res) => {
  await query('DELETE FROM service_blackouts WHERE id = $1 AND service_id = $2', [
    req.params.blackoutId,
    req.params.id,
  ])
  await logBoth(req.user.id, 'service.blackout_removed', req.params.blackoutId)
  res.json({ ok: true })
})

export default router
