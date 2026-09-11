import { getSuperadminEmails } from './notifications.js'
import { sendLowStockAlertEmail } from './email.js'

// Fires only on the CROSSING into low stock — previousQty was above the
// threshold, newQty is now at or below it. Deliberately does NOT re-fire
// on every subsequent order while stock stays low (e.g. a product
// sitting at 2 units, threshold 5, sells one more unit down to 1) — that
// would mean one email per sale on a slow restock, which trains admins
// to ignore the alert entirely. The dashboard's low-stock widget
// (Section 8) already shows the live list regardless; this email is
// just the one-time "heads up, something just crossed the line" nudge.
// If threshold is null/undefined (shouldn't happen — every product has
// a default), this quietly does nothing rather than guessing a number.
export async function maybeSendLowStockAlert({ id, name, previousQty, newQty, threshold }) {
  if (threshold == null) return
  const wasAboveThreshold = previousQty > threshold
  const isNowAtOrBelow = newQty <= threshold
  if (!(wasAboveThreshold && isNowAtOrBelow)) return

  const emails = await getSuperadminEmails()
  await Promise.all(
    emails.map((email) => sendLowStockAlertEmail({ id, name, newQty, threshold }, email))
  )
}
