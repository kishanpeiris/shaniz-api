// Discount maths, in one place so the shop page, basket and the order
// (which recomputes every price on the server) can never disagree.
//
// A row (product or service) has: price_lkr, and optionally
//   discount_type ('percent' | 'fixed'), discount_value,
//   discount_starts_at, discount_ends_at.

export function isDiscountActive(row, now = new Date()) {
  if (!row.discount_type || !(Number(row.discount_value) > 0)) return false
  if (row.discount_starts_at && new Date(row.discount_starts_at) > now) return false
  if (row.discount_ends_at && new Date(row.discount_ends_at) <= now) return false
  return true
}

// The price a customer actually pays right now.
export function effectivePrice(row, now = new Date()) {
  const base = Number(row.price_lkr)
  if (!isDiscountActive(row, now)) return base
  const off = row.discount_type === 'percent' ? (base * Number(row.discount_value)) / 100 : Number(row.discount_value)
  return Math.max(0, Math.round((base - off) * 100) / 100)
}

// Adds `sale_price_lkr` (null when there's no live discount) to an API row.
export function withSalePrice(row) {
  const price = effectivePrice(row)
  return { ...row, sale_price_lkr: price < Number(row.price_lkr) ? price : null }
}

// Returns an error sentence if the discount can't be saved, or null if OK.
export function discountProblem({ discount_type, discount_value, discount_starts_at, discount_ends_at }, price) {
  if (!discount_type) return null
  const v = Number(discount_value)
  if (!(v > 0)) return 'Enter the discount amount (more than 0).'
  if (discount_type === 'percent' && v > 95) return 'A percentage discount can be at most 95%.'
  if (discount_type === 'fixed' && price != null && v >= Number(price)) return 'A fixed discount must be less than the price.'
  if (discount_starts_at && discount_ends_at && new Date(discount_ends_at) <= new Date(discount_starts_at)) {
    return 'The discount end date must be after its start date.'
  }
  return null
}
