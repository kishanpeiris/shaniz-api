import cron from 'node-cron'
import { query } from '../db/pool.js'
import { sendCheckoutReminderEmail } from './email.js'

// Abandoned-CHECKOUT reminders — a different (later, higher-intent) stage
// of the funnel than cartReminders.js. That file catches someone who
// never even started checkout; this one catches someone who filled in
// the whole checkout form (address, delivery method, gateway) and an
// order row exists, but no payment webhook ever confirmed it — the
// order is stuck at status = 'pending'. Covers guest checkouts too,
// since customer_email is captured on every order regardless of
// whether the customer has an account (see orders.routes.js).
//
// Only ONE reminder is ever sent per order (checkout_reminder_sent_at
// IS NULL check below) — there's no "max reminders" setting like
// cartReminders.js has, since a stale pending order rarely benefits
// from being nudged more than once.
//
// Skipped for anyone who has switched "Checkout reminders" off, same
// email_suppressions mechanism as every other optional email type.
//
// NOTE: same caveat as cartReminders.js — runs inside the Node process,
// so on a free host that sleeps, it only runs while awake.

const HOURS = Number(process.env.CHECKOUT_REMINDER_HOURS) || 2

export async function runCheckoutReminders({ hours = HOURS } = {}) {
  const { rows } = await query(
    `SELECT id, items, customer_email, customer_first_name
     FROM orders
     WHERE status = 'pending'
       AND customer_email IS NOT NULL
       AND created_at <= now() - make_interval(hours => $1)
       AND checkout_reminder_sent_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM email_suppressions s
         WHERE s.email = LOWER(orders.customer_email) AND s.type = 'checkout_reminders'
       )`,
    [hours]
  )

  let sent = 0
  for (const row of rows) {
    try {
      const result = await sendCheckoutReminderEmail(row, row.customer_email, row.customer_first_name)
      // Same reasoning as cartReminders.js: count it even in dev
      // (console-only) mode, but not when the email provider actually
      // rejected it, so a temporary email problem doesn't burn the
      // order's one reminder.
      if (result?.error) continue
      await query(`UPDATE orders SET checkout_reminder_sent_at = now() WHERE id = $1`, [row.id])
      sent += 1
    } catch (err) {
      console.error(`[checkout-reminders] failed for order ${row.id}:`, err.message)
    }
  }
  console.log(`[checkout-reminders] sent ${sent} of ${rows.length} due reminder(s)`)
  return { due: rows.length, sent }
}

export function startCheckoutReminderJob() {
  // Offset from cartReminders.js's :20 so the two jobs don't run in the
  // same tick and compete for the same DB connection pool.
  cron.schedule('35 * * * *', () => {
    runCheckoutReminders().catch((err) => console.error('[checkout-reminders] job failed:', err))
  })
}
