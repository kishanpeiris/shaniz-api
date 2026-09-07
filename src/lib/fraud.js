// Rule-based fraud detection — NOT a machine-learning model. For a shop
// this size, a handful of clear, explainable rules catch the common
// abuse patterns (stolen card testing, promo abuse, chargebacks) without
// needing any paid service or training data. Every rule here is a
// judgment call on a threshold — tune the numbers below (or the env
// vars) as real order data comes in; a flag means "worth a human
// glancing at this", not "confirmed fraud".
//
// Runs inside the same DB transaction as order creation (see
// orders.routes.js) so the "past orders" counts below are always
// consistent with the order actually being created.

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'trashmail.com',
  'discard.email',
  'sharklasers.com',
  'getnada.com',
  'throwawaymail.com',
])

const FIRST_ORDER_THRESHOLD_LKR = Number(process.env.FRAUD_FIRST_ORDER_THRESHOLD_LKR || 50000)
const VELOCITY_WINDOW_MINUTES = Number(process.env.FRAUD_VELOCITY_WINDOW_MINUTES || 30)
const VELOCITY_MAX_ORDERS = Number(process.env.FRAUD_VELOCITY_MAX_ORDERS || 3)
const REFUND_HISTORY_THRESHOLD = Number(process.env.FRAUD_REFUND_HISTORY_THRESHOLD || 3)

export async function evaluateOrderRisk(client, order) {
  const {
    orderId,
    userId,
    guestEmail,
    customerEmail,
    totalLkr,
    ip,
    billingAddress,
    billingSameAsShipping,
    customerFirstName,
    customerLastName,
  } = order
  const flags = []

  // 1. Disposable / throwaway email domain — common for one-off promo
  // abuse or accounts nobody intends to actually receive anything at.
  const domain = customerEmail?.split('@')[1]?.toLowerCase()
  if (domain && DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    flags.push({
      code: 'disposable_email',
      severity: 'medium',
      message: `Customer email uses a disposable/throwaway domain (${domain}).`,
    })
  }

  // 2. Unusually large FIRST order — a brand-new customer's very first
  // purchase being far above typical spend is a common stolen-card
  // pattern (test a small charge elsewhere, then max out here).
  const pastOrders = userId
    ? await client.query(
        `SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1 AND id != $2 AND status != 'cancelled'`,
        [userId, orderId]
      )
    : await client.query(
        `SELECT COUNT(*)::int AS n FROM orders WHERE guest_email = $1 AND id != $2 AND status != 'cancelled'`,
        [guestEmail, orderId]
      )
  const isFirstOrder = pastOrders.rows[0].n === 0
  if (isFirstOrder && totalLkr > FIRST_ORDER_THRESHOLD_LKR) {
    flags.push({
      code: 'first_order_high_value',
      severity: 'medium',
      message: `This customer's first-ever order is unusually large (Rs. ${Number(totalLkr).toLocaleString()}).`,
    })
  }

  // 3. Velocity — many orders from the same IP address in a short
  // window. One person genuinely re-ordering is normal; several orders
  // in half an hour from one address usually isn't.
  if (ip) {
    const velocity = await client.query(
      `SELECT COUNT(*)::int AS n FROM orders
       WHERE customer_ip = $1 AND id != $2 AND created_at > now() - make_interval(mins => $3)`,
      [ip, orderId, VELOCITY_WINDOW_MINUTES]
    )
    const total = velocity.rows[0].n + 1
    if (total >= VELOCITY_MAX_ORDERS) {
      flags.push({
        code: 'order_velocity',
        severity: 'high',
        message: `${total} orders from the same IP address within ${VELOCITY_WINDOW_MINUTES} minutes.`,
      })
    }
  }

  // 4. History of cancellations/refunds under this same email — repeat
  // chargebacks or "order then dispute" abuse.
  if (customerEmail) {
    const history = await client.query(
      `SELECT COUNT(*)::int AS n FROM orders WHERE customer_email = $1 AND status IN ('cancelled','refunded')`,
      [customerEmail]
    )
    if (history.rows[0].n >= REFUND_HISTORY_THRESHOLD) {
      flags.push({
        code: 'refund_history',
        severity: 'medium',
        message: `Customer has ${history.rows[0].n} previous cancelled/refunded orders.`,
      })
    }
  }

  // 5. Billing name doesn't match the checkout contact name at all —
  // only checked when billing genuinely differs from shipping (the
  // common, legitimate case of "ship to my office, bill to me" won't
  // trip this since the contact name still matches one of them).
  if (billingSameAsShipping === false && billingAddress && customerFirstName) {
    const nameMatches =
      billingAddress.first_name?.toLowerCase() === customerFirstName.toLowerCase() &&
      billingAddress.last_name?.toLowerCase() === customerLastName?.toLowerCase()
    if (!nameMatches) {
      flags.push({
        code: 'billing_name_mismatch',
        severity: 'low',
        message: `Billing address name doesn't match the checkout contact name.`,
      })
    }
  }

  return flags
}

export async function recordFraudFlags(client, orderId, flags) {
  for (const f of flags) {
    await client.query(`INSERT INTO fraud_flags (order_id, severity, code, message) VALUES ($1,$2,$3,$4)`, [
      orderId,
      f.severity,
      f.code,
      f.message,
    ])
  }
}
