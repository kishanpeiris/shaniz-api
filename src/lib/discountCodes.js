// Everything about checking a discount code lives here, so the "Apply"
// button at checkout and the real order creation can never disagree.
//
// evaluateDiscountCode() never trusts the browser: it looks the code up
// in the database, then checks it against limits the admin set.

export function normalizeCode(raw) {
  return String(raw ?? '').trim().toUpperCase()
}

// Orders that "use up" a code: paid ones, plus unpaid ones started in the
// last 45 minutes (the same window a booking slot is held for).
const COUNTS_AS_USE = `(status IN ('paid', 'shipped', 'completed') OR (status = 'pending' AND created_at > now() - interval '45 minutes'))`
// For the one-per-customer rule only real, paid orders count, so a
// customer whose payment failed can simply try again.
const COUNTS_AS_PAID_USE = `status IN ('paid', 'shipped', 'completed')`

export const REASON_MESSAGES = {
  not_found: 'That discount code is not valid.',
  inactive: 'That discount code is not valid.',
  expired: 'That discount code has expired.',
  max_uses: 'That discount code has reached its usage limit.',
  already_used: 'You have already used that discount code.',
  min_subtotal: 'Your basket is below the minimum amount for that code.',
  empty: 'Your basket is empty.',
}

// Returns { ok: true, codeRow, discountLkr } or { ok: false, reason, ... }.
// `db` is anything with a .query() (a pool client inside a transaction,
// or the shared pool helper). Pass lock: true inside a transaction so two
// customers can't both grab the very last use.
export async function evaluateDiscountCode(db, { code, subtotal, vipDiscountLkr = 0, userId = null, email = null, lock = false }) {
  const normalized = normalizeCode(code)
  if (!normalized) return { ok: false, reason: 'not_found' }
  if (!(subtotal > 0)) return { ok: false, reason: 'empty' }

  const { rows } = await db.query(
    `SELECT * FROM discount_codes WHERE upper(code) = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [normalized]
  )
  const row = rows[0]
  if (!row) return { ok: false, reason: 'not_found' }
  if (!row.is_active) return { ok: false, reason: 'inactive' }
  if (row.expires_at && new Date(row.expires_at) <= new Date()) return { ok: false, reason: 'expired' }
  if (subtotal < Number(row.min_subtotal_lkr)) {
    return { ok: false, reason: 'min_subtotal', min_subtotal_lkr: Number(row.min_subtotal_lkr) }
  }

  if (row.max_total_uses != null) {
    const { rows: c } = await db.query(
      `SELECT count(*)::int AS n FROM orders WHERE discount_code_id = $1 AND ${COUNTS_AS_USE}`,
      [row.id]
    )
    if (c[0].n >= row.max_total_uses) return { ok: false, reason: 'max_uses' }
  }

  // Same person = same account OR same email (covers guests too).
  const lowerEmail = email ? String(email).trim().toLowerCase() : null
  if (row.one_per_customer && (userId || lowerEmail)) {
    const { rows: c } = await db.query(
      `SELECT count(*)::int AS n FROM orders
        WHERE discount_code_id = $1 AND ${COUNTS_AS_PAID_USE}
          AND (($2::uuid IS NOT NULL AND user_id = $2::uuid) OR ($3::text IS NOT NULL AND lower(customer_email) = $3::text))`,
      [row.id, userId, lowerEmail]
    )
    if (c[0].n > 0) return { ok: false, reason: 'already_used' }
  }

  // Both the VIP discount and the code come off the item subtotal (never
  // delivery); together they can never take more than the subtotal.
  const raw = row.discount_type === 'percent' ? Math.round(subtotal * (Number(row.discount_value) / 100)) : Number(row.discount_value)
  const discountLkr = Math.max(0, Math.min(raw, subtotal - vipDiscountLkr))

  return { ok: true, codeRow: row, discountLkr }
}
