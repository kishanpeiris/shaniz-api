import cron from 'node-cron'
import { query } from '../db/pool.js'
import { sendCartReminderEmail } from './email.js'

// Basket reminder emails.
//
// A signed-in customer's basket is saved on the server (saved_carts). If it
// still has items in it and hasn't CHANGED for CART_REMINDER_HOURS (default
// 72 = 3 days), we send ONE reminder email. Each time the customer changes
// their basket (adds, removes, changes a quantity) the 72-hour clock starts
// again and they become eligible for one new reminder. Checking out empties
// the basket, so no reminder follows. (CART_REMINDER_MAX can be raised above
// 1 if you ever want repeat reminders.)
//
// Skipped for anyone who has switched "Basket reminders" off — either in
// their account or with the unsubscribe link in the email.
//
// NOTE: this runs inside the Node process (same as booking reminders). On
// a free host that puts the server to sleep, it only runs while awake —
// on Render use a paid instance, or a free uptime pinger, if you need it
// to be dependable.

const HOURS = Number(process.env.CART_REMINDER_HOURS) || 72
const MAX = Number(process.env.CART_REMINDER_MAX) || 1

export async function runCartReminders({ hours = HOURS, max = MAX } = {}) {
  const { rows } = await query(
    `SELECT c.user_id, c.items, u.email, u.first_name, u.name
     FROM saved_carts c
     JOIN users u ON u.id = c.user_id
     WHERE jsonb_array_length(c.items) > 0
       AND u.disabled = FALSE
       AND c.updated_at <= now() - make_interval(hours => $1)
       AND (c.last_reminder_at IS NULL OR c.last_reminder_at <= now() - make_interval(hours => $1))
       AND c.reminders_sent < $2
       AND NOT EXISTS (
         SELECT 1 FROM email_suppressions s
         WHERE s.email = LOWER(u.email) AND s.type = 'cart_reminders'
       )`,
    [hours, max]
  )

  let sent = 0
  for (const row of rows) {
    try {
      const result = await sendCartReminderEmail(row.email, row.first_name || row.name?.split(' ')[0], row.items)
      // Count it even in dev (console-only) mode, but not when the email
      // provider rejected it — that way a temporary email problem doesn't
      // use up one of the customer's reminders.
      if (result?.error) continue
      await query(
        `UPDATE saved_carts SET last_reminder_at = now(), reminders_sent = reminders_sent + 1 WHERE user_id = $1`,
        [row.user_id]
      )
      sent += 1
    } catch (err) {
      console.error(`[cart-reminders] failed for user ${row.user_id}:`, err.message)
    }
  }
  console.log(`[cart-reminders] sent ${sent} of ${rows.length} due reminder(s)`)
  return { due: rows.length, sent }
}

export function startCartReminderJob() {
  // Checked once an hour, so a reminder goes out within an hour of being due.
  cron.schedule('20 * * * *', () => {
    runCartReminders().catch((err) => console.error('[cart-reminders] job failed:', err))
  })
}
