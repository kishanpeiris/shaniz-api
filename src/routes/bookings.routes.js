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

// Works out the open slots for one service on one date. Used both to show
// the customer the open times AND to double-check a booking request
// before saving it (so nobody can book a closed day by tampering).
//
// How the available times are decided:
//  1. The service's own weekly windows for that weekday. If the service
//     has NO windows at all and its branch has opening hours, the branch's
//     opening hours are used instead ("follow the shop hours").
//  2. Whatever the source, times are cut to the branch's opening hours
//     for that weekday, and a day the branch is closed has no slots.
//  3. Blackout days (days off) and already-booked times are removed.
async function computeSlots(serviceId, dateStr) {
  const service = await query(
    'SELECT id, duration_minutes, service_type, branch_id FROM services WHERE id = $1 AND is_active = TRUE',
    [serviceId]
  )
  if (!service.rows[0]) return { status: 404, error: 'Service not found.' }
  if (service.rows[0].service_type !== 'bookable') {
    return { status: 400, error: 'This service does not use time slots.' }
  }
  const duration = service.rows[0].duration_minutes
  const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay()

  const blackout = await query(
    `SELECT 1 FROM service_blackouts
     WHERE blackout_date = $1 AND (service_id = $2 OR service_id IS NULL)`,
    [dateStr, serviceId]
  )
  if (blackout.rows.length > 0) return { slots: [] }

  let branchHours = null
  if (service.rows[0].branch_id) {
    const b = await query('SELECT opening_hours FROM branches WHERE id = $1', [service.rows[0].branch_id])
    branchHours = b.rows[0]?.opening_hours ?? null
  }
  const dayHours = branchHours ? branchHours[String(dayOfWeek)] : null
  if (branchHours && !dayHours) return { slots: [] } // branch closed that day

  const own = await query(
    `SELECT start_time, end_time FROM service_availability
     WHERE service_id = $1 AND day_of_week = $2`,
    [serviceId, dayOfWeek]
  )
  let windows = own.rows
  if (windows.length === 0 && dayHours) {
    const anyOwn = await query('SELECT 1 FROM service_availability WHERE service_id = $1 LIMIT 1', [serviceId])
    if (anyOwn.rows.length === 0) windows = [{ start_time: dayHours.open, end_time: dayHours.close }]
  }

  const booked = await query(
    `SELECT booked_time FROM bookings
     WHERE service_id = $1 AND booked_date = $2 AND status != 'cancelled'`,
    [serviceId, dateStr]
  )
  const bookedTimes = new Set(booked.rows.map((r) => r.booked_time))

  const slots = []
  for (const w of windows) {
    let cursor = toMinutes(w.start_time)
    let end = toMinutes(w.end_time)
    if (dayHours) {
      cursor = Math.max(cursor, toMinutes(dayHours.open))
      end = Math.min(end, toMinutes(dayHours.close))
    }
    while (cursor + duration <= end) {
      const t = toTimeString(cursor)
      if (!bookedTimes.has(t)) slots.push(t)
      cursor += duration
    }
  }
  return { slots }
}

// Public: open slots for a service on a given date. This is the
// customer-facing side of "customer sees only open slots (already-booked
// slots automatically hidden)" from the spec.
router.get('/services/:serviceId/slots', async (req, res) => {
  const dateStr = req.query.date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? '')) {
    return res.status(400).json({ error: 'date query param must be YYYY-MM-DD.' })
  }
  const result = await computeSlots(req.params.serviceId, dateStr)
  if (result.error) return res.status(result.status).json({ error: result.error })
  res.json({ date: dateStr, slots: result.slots })
})

// Friendly, plain-language phone check (Sri Lankan numbers, with or
// without +94): 9-12 digits, spaces/dashes/brackets allowed.
const PHONE_MESSAGE =
  'Please enter a valid phone number, for example 0771234567 (mobile) or 0112345678 (home).'
const phoneField = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z
    .string()
    .trim()
    .refine((v) => {
      const digits = v.replace(/\D/g, '')
      return /^\+?[\d\s\-()]+$/.test(v) && digits.length >= 9 && digits.length <= 12
    }, PHONE_MESSAGE)
    .optional()
)

const bookingSchema = z.object({
  service_id: z.string().uuid('Something went wrong with that service — please close this window and try again.'),
  booked_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Please pick a valid date.'),
  booked_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Please pick one of the available times.'),
  // Only required for guest bookings (no session) — see the check below.
  // guest_name is one field (not first/last) since it's just for display
  // and the confirmation email; mononym-friendly by not splitting it.
  guest_name: z.string().trim().min(1, 'Please enter your name.').max(200, 'That name is too long.').optional(),
  guest_email: z.string().trim().email('Please enter a valid email address, like name@example.com.').optional(),
  guest_mobile: phoneField,
  guest_home_phone: phoneField,
})

router.post('/', async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const { service_id, booked_date, booked_time, guest_name, guest_email, guest_mobile, guest_home_phone } = parsed.data

  if (!req.user && (!guest_name || !guest_email)) {
    return res.status(400).json({ error: 'Please enter your name and email so we can send your booking confirmation.' })
  }
  // At least one way to reach the customer: a mobile or a home phone
  // (a signed-in customer's saved mobile counts).
  if (!guest_mobile && !guest_home_phone && !req.user?.mobile) {
    return res.status(400).json({
      error: 'Please give us at least one phone number — a mobile or a home phone — so we can reach you about your booking.',
    })
  }

  // Re-check the time against the real opening hours / windows / days off
  // (not just what the page showed), so a closed day can't be booked.
  const check = await computeSlots(service_id, booked_date)
  if (check.error) return res.status(check.status).json({ error: check.error })
  const wanted = booked_time.length === 5 ? `${booked_time}:00` : booked_time
  if (!check.slots.includes(wanted)) {
    return res.status(409).json({ error: "Sorry, that time isn't available any more — please pick another time." })
  }

  try {
    const { rows } = await query(
      `INSERT INTO bookings (service_id, user_id, guest_name, guest_email, guest_mobile, guest_home_phone, booked_date, booked_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        service_id,
        req.user?.id ?? null,
        req.user ? null : guest_name,
        req.user ? null : guest_email,
        guest_mobile ?? null,
        guest_home_phone ?? null,
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
    `SELECT b.*, s.name AS service_name, u.name AS user_name, u.email AS user_email, u.mobile AS user_mobile
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
