import cron from 'node-cron'
import { query } from '../db/pool.js'
import { sendWishlistReminderEmail } from './email.js'
import { effectivePrice } from './pricing.js'

// Wishlist reminder email — ONE friendly follow-up.
//
// When a signed-in customer has saved something and it has sat on their
// wishlist for WISHLIST_REMINDER_HOURS (default 168 = 7 days), they get a
// single email listing what's still available. Every item in that email is
// marked as "reminded" so it is never mentioned again, and a customer gets
// at most one wishlist email per WISHLIST_REMINDER_GAP_DAYS (default 30),
// however much they save.
//
// Left out on purpose: items that are sold out, no longer sold, or that
// the customer has already bought. Skipped entirely (and NOT marked as
// reminded) for anyone who switched "Wishlist reminder" off — either in
// their account settings or with the link in the email.
//
// NOTE: runs inside the Node process, like the basket/booking reminders —
// on a host that puts the server to sleep it only runs while awake.

const HOURS = Number(process.env.WISHLIST_REMINDER_HOURS) || 168
const GAP_DAYS = Number(process.env.WISHLIST_REMINDER_GAP_DAYS) || 30
const LIST_MAX = 5

export async function runWishlistReminders({ hours = HOURS, gapDays = GAP_DAYS } = {}) {
  const { rows } = await query(
    `SELECT w.user_id, w.item_type, w.item_id, u.email, u.first_name, u.name AS user_name,
            COALESCE(p.name, s.name) AS name,
            COALESCE(p.price_lkr, s.price_lkr) AS price_lkr,
            COALESCE(p.discount_type, s.discount_type) AS discount_type,
            COALESCE(p.discount_value, s.discount_value) AS discount_value,
            COALESCE(p.discount_starts_at, s.discount_starts_at) AS discount_starts_at,
            COALESCE(p.discount_ends_at, s.discount_ends_at) AS discount_ends_at
       FROM wishlist_items w
       JOIN users u ON u.id = w.user_id AND u.disabled = FALSE
       LEFT JOIN products p ON w.item_type = 'product' AND p.id = w.item_id AND p.is_active = TRUE
       LEFT JOIN services s ON w.item_type = 'service' AND s.id = w.item_id AND s.is_active = TRUE
      WHERE w.reminded_at IS NULL
        AND w.created_at <= now() - make_interval(hours => $1)
        AND (p.id IS NOT NULL OR s.id IS NOT NULL)
        AND (p.id IS NULL OR p.availability_mode = 'preorder' OR (p.availability_mode = 'in_stock' AND p.stock_qty > 0))
        AND NOT EXISTS (SELECT 1 FROM email_suppressions x WHERE x.email = LOWER(u.email) AND x.type = 'wishlist_reminders')
        AND NOT EXISTS (SELECT 1 FROM wishlist_items r WHERE r.user_id = w.user_id AND r.reminded_at > now() - make_interval(days => $2))
        AND NOT EXISTS (
          SELECT 1 FROM orders o
           WHERE o.user_id = w.user_id AND o.status IN ('paid', 'shipped', 'completed')
             AND o.items @> jsonb_build_array(jsonb_build_object('id', w.item_id::text))
        )
      ORDER BY w.user_id, w.created_at DESC`,
    [hours, gapDays]
  )

  const byUser = new Map()
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, [])
    byUser.get(r.user_id).push(r)
  }

  let sent = 0
  for (const [userId, items] of byUser) {
    const first = items[0]
    try {
      const listed = items.slice(0, LIST_MAX).map((i) => ({ type: i.item_type, id: i.item_id, name: i.name, price: effectivePrice(i) }))
      const result = await sendWishlistReminderEmail(first.email, first.first_name || first.user_name?.split(' ')[0], listed, items.length - listed.length)
      // A provider refusal must not use up the customer's one reminder.
      if (result?.error) continue
      await query(
        `UPDATE wishlist_items SET reminded_at = now()
          WHERE user_id = $1 AND reminded_at IS NULL AND (item_type, item_id) IN (SELECT * FROM unnest($2::text[], $3::uuid[]))`,
        [userId, items.map((i) => i.item_type), items.map((i) => i.item_id)]
      )
      sent += 1
    } catch (err) {
      console.error(`[wishlist-reminders] failed for user ${userId}:`, err.message)
    }
  }
  console.log(`[wishlist-reminders] sent ${sent} of ${byUser.size} due reminder(s)`)
  return { due: byUser.size, sent }
}

export function startWishlistReminderJob() {
  // Checked once an hour, so a reminder goes out within an hour of being due.
  cron.schedule('40 * * * *', () => {
    runWishlistReminders().catch((err) => console.error('[wishlist-reminders] job failed:', err))
  })
}
