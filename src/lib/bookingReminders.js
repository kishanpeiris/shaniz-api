import cron from 'node-cron'
import { query } from '../db/pool.js'
import { sendBookingReminderEmail } from './email.js'

// Day-before booking reminder emails. Same "runs inside the Node process"
// pattern as src/lib/logPurge.js — if your Postgres host supports pg_cron
// (Neon/Supabase do), that's more resilient (keeps running even if this
// app process restarts or is asleep), but this fallback needs zero extra
// setup and is fine for this site's scale.
//
// Runs once a day. Any booking whose date is "tomorrow" (relative to
// whenever this job runs), still 'confirmed', and hasn't already been
// reminded gets exactly one email. reminder_sent is flipped to TRUE right
// after a successful send so re-running the job (or a slow morning) never
// double-emails someone.

export function startBookingReminderJob() {
  // Runs daily at 08:00 server time — late enough to be a normal hour to
  // receive an email, early enough to give a full day's notice.
  cron.schedule('0 8 * * *', async () => {
    try {
      const settings = await query(`SELECT value FROM site_settings WHERE key = 'booking_reminders'`)
      const enabled = settings.rows[0]?.value?.enabled !== false // default on if the row is ever missing
      if (!enabled) {
        console.log('[booking-reminders] skipped — turned off in Settings')
        return
      }

      // LEFT JOIN users to resolve a logged-in customer's email; guest
      // bookings already carry their own email on the row. Same
      // resolution order as bookings.routes.js on creation.
      const { rows } = await query(
        `SELECT b.id, b.booked_date, b.booked_time, b.guest_email,
                u.email AS user_email, s.name AS service_name
         FROM bookings b
         JOIN services s ON s.id = b.service_id
         LEFT JOIN users u ON u.id = b.user_id
         WHERE b.booked_date = CURRENT_DATE + 1
           AND b.status = 'confirmed'
           AND b.reminder_sent = FALSE`
      )

      let sent = 0
      for (const row of rows) {
        const toEmail = row.user_email ?? row.guest_email
        if (!toEmail) continue // no email on file — nothing to send, leave reminder_sent as-is so it's easy to spot in a query if this ever matters
        try {
          await sendBookingReminderEmail(row, row.service_name, toEmail)
          await query(`UPDATE bookings SET reminder_sent = TRUE WHERE id = $1`, [row.id])
          sent += 1
        } catch (err) {
          // One failed email should never stop the rest of the batch.
          console.error(`[booking-reminders] failed to send for booking ${row.id}:`, err.message)
        }
      }
      console.log(`[booking-reminders] sent ${sent} of ${rows.length} due reminder(s)`)
    } catch (err) {
      console.error('[booking-reminders] job failed:', err)
    }
  })
}
