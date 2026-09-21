import { Router } from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { logBoth } from '../lib/log.js'
import { sendBookingUpdateEmail } from '../lib/email.js'
import { notifyBookingConfirmed } from '../lib/orderBookings.js'

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
async function computeSlots(serviceId, dateStr, branchIdWanted) {
  const service = await query(
    'SELECT id, duration_minutes, service_type FROM services WHERE id = $1 AND is_active = TRUE',
    [serviceId]
  )
  if (!service.rows[0]) return { status: 404, error: 'Service not found.' }
  if (service.rows[0].service_type !== 'bookable') {
    return { status: 400, error: 'This service does not use time slots.' }
  }
  const duration = service.rows[0].duration_minutes
  const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay()

  // Which branch? A service is offered at the branches an admin ticked for it
  // (Admin → Branches → Services offered here). If it's offered at just one,
  // that one is used automatically; otherwise the customer must choose.
  const offered = await query('SELECT branch_id FROM service_branches WHERE service_id = $1', [serviceId])
  if (offered.rows.length === 0) {
    return { status: 400, error: 'This service is not offered at any branch yet.' }
  }
  let branchId = branchIdWanted
  if (!branchId && offered.rows.length === 1) branchId = offered.rows[0].branch_id
  if (!branchId) return { status: 400, error: 'Please choose a branch.' }
  if (!offered.rows.some((r) => r.branch_id === branchId)) {
    return { status: 400, error: 'That service is not offered at the branch you chose.' }
  }

  const blackout = await query(
    `SELECT 1 FROM service_blackouts
     WHERE blackout_date = $1 AND (service_id = $2 OR service_id IS NULL)`,
    [dateStr, serviceId]
  )
  if (blackout.rows.length > 0) return { slots: [], branchId }

  const b = await query('SELECT opening_hours FROM branches WHERE id = $1', [branchId])
  const branchHours = b.rows[0]?.opening_hours ?? null
  const dayHours = branchHours ? branchHours[String(dayOfWeek)] : null
  if (branchHours && !dayHours) return { slots: [], branchId } // branch closed that day

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

  // Taken = confirmed/completed bookings, plus slots another customer is
  // holding right now (in their basket / paying) that haven't run out yet.
  const booked = await query(
    `SELECT booked_time FROM bookings
     WHERE service_id = $1 AND booked_date = $2 AND branch_id = $3
       AND status != 'cancelled' AND (status != 'held' OR held_until > now())`,
    [serviceId, dateStr, branchId]
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
  return { slots, branchId }
}

// Public: open slots for a service on a given date. This is the
// customer-facing side of "customer sees only open slots (already-booked
// slots automatically hidden)" from the spec.
router.get('/services/:serviceId/slots', async (req, res) => {
  const dateStr = req.query.date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? '')) {
    return res.status(400).json({ error: 'date query param must be YYYY-MM-DD.' })
  }
  const branchId = /^[0-9a-f-]{36}$/i.test(req.query.branch_id ?? '') ? req.query.branch_id : undefined
  const result = await computeSlots(req.params.serviceId, dateStr, branchId)
  if (result.error) return res.status(result.status).json({ error: result.error })
  res.json({ date: dateStr, branch_id: result.branchId, slots: result.slots })
})

// ---- Holding a slot while the customer pays ----
// Pressing "Add to basket" on a bookable service reserves that slot for
// HOLD_MINUTES. The booking is only CONFIRMED once payment succeeds (see
// lib/orderBookings.js). If the hold runs out, the slot is released.
export const HOLD_MINUTES = 20

const holdSchema = z.object({
  service_id: z.string().uuid('Something went wrong with that service — please try again.'),
  branch_id: z.string().uuid('Please choose a branch.'),
  booked_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Please pick a valid date.'),
  booked_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Please pick one of the available times.'),
})

router.post('/hold', async (req, res) => {
  const parsed = holdSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const { service_id, branch_id, booked_date, booked_time } = parsed.data

  // Free up any holds that have run out first, so their slots count as open.
  await query(`UPDATE bookings SET status = 'cancelled' WHERE status = 'held' AND held_until <= now()`)

  const check = await computeSlots(service_id, booked_date, branch_id)
  if (check.error) return res.status(check.status).json({ error: check.error })
  const wanted = booked_time.length === 5 ? `${booked_time}:00` : booked_time
  if (!check.slots.includes(wanted)) {
    return res.status(409).json({ error: "Sorry, that time isn't available any more — please pick another time." })
  }

  const token = crypto.randomBytes(16).toString('hex')
  try {
    const { rows } = await query(
      `INSERT INTO bookings (service_id, branch_id, user_id, booked_date, booked_time, status, held_until, hold_token)
       VALUES ($1, $2, $3, $4, $5, 'held', now() + make_interval(mins => $6), $7)
       RETURNING id, held_until`,
      [service_id, branch_id, req.user?.id ?? null, booked_date, wanted, HOLD_MINUTES, token]
    )
    res.status(201).json({ hold: { id: rows[0].id, token, expires_at: rows[0].held_until } })
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That slot was just taken by someone else — please pick another.' })
    }
    throw err
  }
})

// Let go of a hold (customer removed it from the basket or picked another time).
router.delete('/hold/:id', async (req, res) => {
  const token = String(req.body?.token ?? '')
  await query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND hold_token = $2 AND status = 'held' AND order_id IS NULL`,
    [req.params.id, token]
  )
  res.json({ ok: true })
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
  branch_id: z.string().uuid('Please choose a branch.'),
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

// Staff only: enter a booking by hand (e.g. taken over the phone / paid at the counter).
// Customers book through the basket and pay first — see /hold above.
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const { service_id, branch_id, booked_date, booked_time, guest_name, guest_email, guest_mobile, guest_home_phone } = parsed.data

  if (!guest_name || !guest_email) {
    return res.status(400).json({ error: "Please enter the customer's name and email." })
  }
  if (!guest_mobile && !guest_home_phone) {
    return res.status(400).json({ error: 'Please enter at least one phone number — a mobile or a home phone.' })
  }
  await query(`UPDATE bookings SET status = 'cancelled' WHERE status = 'held' AND held_until <= now()`)
  const check = await computeSlots(service_id, booked_date, branch_id)
  if (check.error) return res.status(check.status).json({ error: check.error })
  const wanted = booked_time.length === 5 ? `${booked_time}:00` : booked_time
  if (!check.slots.includes(wanted)) {
    return res.status(409).json({ error: "That time isn't available — pick another." })
  }

  try {
    const { rows } = await query(
      `INSERT INTO bookings (service_id, branch_id, user_id, guest_name, guest_email, guest_mobile, guest_home_phone, booked_date, booked_time, status)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, 'confirmed') RETURNING *`,
      [service_id, branch_id, guest_name, guest_email, guest_mobile ?? null, guest_home_phone ?? null, booked_date, wanted]
    )
    await logBoth(req.user.id, 'booking.created_by_staff', rows[0].id)
    await notifyBookingConfirmed(rows[0].id)
    res.status(201).json({ booking: rows[0] })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That slot is already booked.' })
    throw err
  }
})

// Customer: view their own bookings.
router.get('/mine', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name, br.name AS branch_name, br.address AS branch_address
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     LEFT JOIN branches br ON br.id = b.branch_id
     WHERE b.user_id = $1 AND b.status IN ('confirmed', 'completed') ORDER BY b.booked_date, b.booked_time`,
    [req.user.id]
  )
  res.json({ bookings: rows })
})

// Admin: calendar view of all upcoming bookings.
router.get('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name, br.name AS branch_name, u.name AS user_name, u.email AS user_email, u.mobile AS user_mobile,
            o.customer_first_name, o.customer_last_name, o.customer_email AS order_email, o.customer_phone AS order_phone
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     LEFT JOIN branches br ON br.id = b.branch_id
     LEFT JOIN orders o ON o.id = b.order_id
     LEFT JOIN users u ON u.id = b.user_id
     WHERE b.booked_date >= CURRENT_DATE AND b.status != 'cancelled' AND (b.status != 'held' OR b.held_until > now())
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
