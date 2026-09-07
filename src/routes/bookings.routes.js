import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { logBoth } from '../lib/log.js'
import { sendBookingConfirmationEmail, sendBookingUpdateEmail } from '../lib/email.js'
import { sendBookingConfirmationSms } from '../lib/sms.js'

const router = Router()

const toMinutes = (t) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
const toTimeString = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`

// Public: open slots for a service on a given date. This is the
// customer-facing side of "customer sees only open slots (already-booked
// slots automatically hidden)" from the spec.
router.get('/services/:serviceId/slots', async (req, res) => {
  const dateStr = req.query.date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? '')) {
    return res.status(400).json({ error: 'date query param must be YYYY-MM-DD.' })
  }

  const service = await query(
    'SELECT id, duration_minutes, service_type FROM services WHERE id = $1 AND is_active = TRUE',
    [req.params.serviceId]
  )
  if (!service.rows[0]) return res.status(404).json({ error: 'Service not found.' })
  if (service.rows[0].service_type !== 'bookable') {
    return res.status(400).json({ error: 'This service does not use time slots.' })
  }
  const duration = service.rows[0].duration_minutes

  const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay()

  const blackout = await query(
    `SELECT 1 FROM service_blackouts
     WHERE blackout_date = $1 AND (service_id = $2 OR service_id IS NULL)`,
    [dateStr, req.params.serviceId]
  )
  if (blackout.rows.length > 0) {
    return res.json({ date: dateStr, slots: [] })
  }

  const windows = await query(
    `SELECT start_time, end_time FROM service_availability
     WHERE service_id = $1 AND day_of_week = $2`,
    [req.params.serviceId, dayOfWeek]
  )

  const booked = await query(
    `SELECT booked_time FROM bookings
     WHERE service_id = $1 AND booked_date = $2 AND status != 'cancelled'`,
    [req.params.serviceId, dateStr]
  )
  const bookedTimes = new Set(booked.rows.map((r) => r.booked_time))

  const slots = []
  for (const w of windows.rows) {
    let cursor = toMinutes(w.start_time)
    const end = toMinutes(w.end_time)
    while (cursor + duration <= end) {
      const t = toTimeString(cursor)
      if (!bookedTimes.has(t)) slots.push(t)
      cursor += duration
    }
  }

  res.json({ date: dateStr, slots })
})

const bookingSchema = z.object({
  service_id: z.string().uuid(),
  booked_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  booked_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  // Only required for guest bookings (no session) — see the check below.
  // guest_name is one field (not first/last) since it's just for display
  // and the confirmation email; mononym-friendly by not splitting it.
  guest_name: z.string().min(1).max(200).optional(),
  guest_email: z.string().email().optional(),
  guest_mobile: z.string().min(7).max(20).optional(),
})

router.post('/', async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const { service_id, booked_date, booked_time, guest_name, guest_email, guest_mobile } = parsed.data

  if (!req.user && (!guest_name || !guest_email)) {
    return res.status(400).json({ error: 'guest_name and guest_email are required when not signed in.' })
  }

  try {
    const { rows } = await query(
      `INSERT INTO bookings (service_id, user_id, guest_name, guest_email, guest_mobile, booked_date, booked_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        service_id,
        req.user?.id ?? null,
        req.user ? null : guest_name,
        req.user ? null : guest_email,
        req.user ? null : guest_mobile ?? null,
        booked_date,
        booked_time,
      ]
    )
    await logBoth(req.user?.id ?? null, 'booking.created', rows[0].id)

    const recipientEmail = req.user?.email ?? guest_email
    const serviceRow = await query('SELECT name FROM services WHERE id = $1', [service_id])
    if (recipientEmail) {
      await sendBookingConfirmationEmail(rows[0], serviceRow.rows[0]?.name ?? 'Service', recipientEmail)
    }
    // Mobile is optional for both guests and logged-in customers — only
    // sent if one is actually on file.
    const recipientMobile = req.user?.mobile ?? guest_mobile
    if (recipientMobile) {
      await sendBookingConfirmationSms(rows[0], serviceRow.rows[0]?.name ?? 'Service', recipientMobile)
    }

    res.status(201).json({ booking: rows[0] })
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation on (service_id, booked_date, booked_time)
      return res.status(409).json({ error: 'That slot was just booked by someone else — pick another.' })
    }
    throw err
  }
})

// Customer: view their own bookings.
router.get('/mine', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.user_id = $1 ORDER BY b.booked_date, b.booked_time`,
    [req.user.id]
  )
  res.json({ bookings: rows })
})

// Admin: calendar view of all upcoming bookings.
router.get('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name, u.name AS user_name, u.email AS user_email
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     LEFT JOIN users u ON u.id = b.user_id
     WHERE b.booked_date >= CURRENT_DATE AND b.status != 'cancelled'
     ORDER BY b.booked_date, b.booked_time`
  )
  res.json({ bookings: rows })
})

// Admin: reschedule or cancel. Customer self-service is a documented v2.
const updateSchema = z.object({
  status: z.enum(['confirmed', 'completed', 'cancelled']).optional(),
  booked_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  booked_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
})

router.put('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const fields = parsed.data
  const keys = Object.keys(fields)
  if (keys.length === 0) return res.status(400).json({ error: 'No fields to update.' })

  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
  const values = keys.map((k) => fields[k])

  try {
    const { rows } = await query(
      `UPDATE bookings SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found.' })
    await logBoth(req.user.id, 'booking.updated', rows[0].id, fields)

    const booking = rows[0]
    const recipientEmail =
      booking.guest_email ??
      (booking.user_id
        ? (await query('SELECT email FROM users WHERE id = $1', [booking.user_id])).rows[0]?.email
        : null)
    if (recipientEmail && (fields.status || fields.booked_date || fields.booked_time)) {
      const serviceRow = await query('SELECT name FROM services WHERE id = $1', [booking.service_id])
      await sendBookingUpdateEmail(booking, serviceRow.rows[0]?.name ?? 'Service', recipientEmail)
    }

    res.json({ booking })
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That slot is already taken.' })
    }
    throw err
  }
})

export default router
