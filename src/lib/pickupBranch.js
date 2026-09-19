import { query } from '../db/pool.js'

// Order rows fetched fresh from the database (webhooks, sandbox-pay)
// don't carry the joined branch details the way the order-creation
// endpoint does right after INSERT — this fills that back in wherever
// an email or PDF is about to be rendered for a pickup order. A no-op
// (returns the order unchanged) for delivery orders, since
// pickup_branch_id is only ever set for pickup ones.
export async function attachPickupBranch(order) {
  if (!order?.pickup_branch_id) return order
  const { rows } = await query('SELECT * FROM branches WHERE id = $1', [order.pickup_branch_id])
  return { ...order, pickup_branch: rows[0] || null }
}

// Prefers exact coordinates (drops a precise pin) over the text address
// (falls back to Maps' own geocoding of the address string) — either
// way this is a real, clickable "open in Google Maps" link, not just
// the address printed as plain text. Shared by the invoice email
// (lib/email.js) and the PDF invoice (lib/pdf.js).
export function googleMapsLink(branch) {
  const target = branch.latitude != null && branch.longitude != null
    ? `${branch.latitude},${branch.longitude}`
    : branch.address
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(target)}`
}
