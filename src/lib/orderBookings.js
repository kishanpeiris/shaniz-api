import cron from 'node-cron'
import { query } from '../db/pool.js'
import { sendBookingConfirmationEmail } from './email.js'
import { sendBookingConfirmationSms } from './sms.js'
import { logAudit } from './log.js'

// How a booking follows its order:
//   order created   -> the slot stays 'held' (see routes/bookings.routes.js)
//   payment succeeds-> booking becomes 'confirmed' and the confirmation goes out
//   order cancelled / refunded -> the booking is cancelled and the slot freed

// Sends the "your booking is confirmed" email (and SMS if a mobile is known).
// Works for both paid-online bookings and ones a staff member entered.
export async function notifyBookingConfirmed(bookingId) {
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name, br.name AS branch_name, br.address AS branch_address, br.phone AS branch_phone,
            u.email AS user_email, u.mobile AS user_mobile,
            o.customer_email AS order_email, o.customer_phone AS order_phone
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     LEFT JOIN branches br ON br.id = b.branch_id
     LEFT JOIN users u ON u.id = b.user_id
     LEFT JOIN orders o ON o.id = b.order_id
     WHERE b.id = $1`,
    [bookingId]
  )
  const b = rows[0]
  if (!b) return
  const email = b.guest_email ?? b.order_email ?? b.user_email
  const mobile = b.guest_mobile ?? b.order_phone ?? b.user_mobile
  const booking = { ...b, branch: { name: b.branch_name, address: b.branch_address, phone: b.branch_phone } }
  if (email) await sendBookingConfirmationEmail(booking, b.service_name, email)
  if (mobile) await sendBookingConfirmationSms(booking, b.service_name, mobile)
}

export async function syncBookingsWithOrderStatus(orderId, status) {
  if (status === 'paid') {
    const { rows } = await query(
      `UPDATE bookings SET status = 'confirmed', held_until = NULL
       WHERE order_id = $1 AND status = 'held' RETURNING id`,
      [orderId]
    )
    for (const r of rows) await notifyBookingConfirmed(r.id)

    // A payment can (rarely) arrive after the hold ran out and the slot was
    // released. Try to take the slot back; if someone else got it, flag it so
    // a person can rebook the customer or refund them.
    const expired = await query(`SELECT id FROM bookings WHERE order_id = $1 AND status = 'cancelled'`, [orderId])
    for (const r of expired.rows) {
      try {
        await query(`UPDATE bookings SET status = 'confirmed', held_until = NULL WHERE id = $1`, [r.id])
        await notifyBookingConfirmed(r.id)
      } catch {
        await logAudit(null, 'booking.lost_after_payment', r.id, { order_id: orderId })
        console.error(`[bookings] Order ${orderId} was paid but booking ${r.id} lost its slot — needs manual follow-up (rebook or refund).`)
      }
    }
  } else if (status === 'cancelled' || status === 'refunded') {
    await query(
      `UPDATE bookings SET status = 'cancelled', held_until = NULL WHERE order_id = $1 AND status IN ('held', 'confirmed')`,
      [orderId]
    )
  }
}

// Frees slots whose hold ran out (customer left, or never finished paying).
export async function releaseExpiredHolds() {
  const { rowCount } = await query(`UPDATE bookings SET status = 'cancelled' WHERE status = 'held' AND held_until <= now()`)
  return rowCount
}

export function startBookingHoldJob() {
  cron.schedule('* * * * *', () => {
    releaseExpiredHolds().catch((err) => console.error('[booking-holds] cleanup failed:', err.message))
  })
}
