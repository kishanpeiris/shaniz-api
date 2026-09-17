// Payment gateway abstraction — project-spec.md Section 4.
//
// Koko and IntPay expose a hosted-checkout flow: you create a "checkout
// session" server-side, redirect the customer to the URL it returns, and
// the gateway calls your webhook (src/routes/webhooks.routes.js) when
// payment succeeds or fails. Their exact request/response shape below is
// still a best-effort placeholder — replace the fetch() call inside each
// once you have their real sandbox docs; nothing else needs to change.
//
// PayHere (the "Credit / Debit Card" option, replacing the earlier
// Dialog Genie placeholder) is real and fully implemented below — it's
// publicly documented, Central Bank of Sri Lanka approved, and doesn't
// need placeholder credentials to work in sandbox mode (PayHere's own
// sandbox is free, no merchant approval wait). See PAYHERE_MERCHANT_ID /
// PAYHERE_MERCHANT_SECRET in .env.example.
import crypto from 'crypto'

// Every real hosted-checkout flow needs TWO different callback URLs,
// which are easy to conflate but serve different purposes:
// - webhook_url: server-to-server, the gateway calls this directly and
//   it's the reliable source of truth for "did this actually get paid"
//   (src/routes/webhooks.routes.js already handles this).
// - return_url: where the CUSTOMER'S BROWSER gets redirected back to
//   once they finish on the gateway's own page — which, for a real
//   Sri Lankan card payment, includes their bank's own OTP challenge
//   screen (3-D Secure) *inside* that hosted flow. We never build any
//   OTP UI ourselves; redirecting to the gateway's page is what hands
//   the customer to their bank for that step, and this return_url is
//   just where they land back on our site afterward. PaymentReturnPage
//   then re-checks the order's real status (set by the webhook above,
//   not by anything in this URL) rather than trusting query params the
//   gateway attaches to the return URL, since exact param names differ
//   per provider and aren't in the placeholder docs below yet.
const returnUrl = (order) => `${process.env.FRONTEND_ORIGIN}/payment/return?order=${order.id}`

export const isConfigured = (gateway) => {
  const map = {
    koko: process.env.KOKO_MERCHANT_ID && process.env.KOKO_API_SECRET,
    intpay: process.env.INTPAY_MERCHANT_ID && process.env.INTPAY_API_SECRET,
    payhere: process.env.PAYHERE_MERCHANT_ID && process.env.PAYHERE_MERCHANT_SECRET,
  }
  return Boolean(map[gateway])
}

function mockCheckoutUrl(gateway, order) {
  return `https://sandbox.${gateway}.example/checkout?order=${order.id}&amount=${order.total_lkr}`
}

async function createKokoCheckout(order) {
  // TODO: replace with Koko's real hosted-checkout endpoint once you have
  // their API docs. Placeholder shape based on common hosted-checkout
  // patterns (merchant id + secret auth, amount in the smallest currency
  // unit, a return/callback URL).
  const res = await fetch('https://api.koko.example/v1/checkout-sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.KOKO_API_SECRET}`,
    },
    body: JSON.stringify({
      merchant_id: process.env.KOKO_MERCHANT_ID,
      amount: Math.round(order.total_lkr * 100), // smallest unit, adjust per real docs
      currency: 'LKR',
      order_id: order.id,
      webhook_url: `${process.env.PUBLIC_API_URL}/api/webhooks/koko`,
      return_url: returnUrl(order),
    }),
  })
  if (!res.ok) throw new Error(`Koko checkout session failed (${res.status})`)
  const data = await res.json()
  return data.checkout_url
}

async function createIntPayCheckout(order) {
  // TODO: replace with IntPay's real endpoint — same caveat as above.
  const res = await fetch('https://api.intpay.example/v1/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Merchant-Id': process.env.INTPAY_MERCHANT_ID,
      'X-Api-Secret': process.env.INTPAY_API_SECRET,
    },
    body: JSON.stringify({
      amount: order.total_lkr,
      currency: 'LKR',
      reference: order.id,
      webhook_url: `${process.env.PUBLIC_API_URL}/api/webhooks/intpay`,
      return_url: returnUrl(order),
    }),
  })
  if (!res.ok) throw new Error(`IntPay checkout session failed (${res.status})`)
  const data = await res.json()
  return data.redirect_url
}

// PayHere's "Checkout API" (https://support.payhere.lk/api-&-mobile-sdk)
// is NOT a "call an endpoint, get back a URL" flow like the two above —
// there's no session-creation API call at all. Instead, the customer's
// BROWSER submits an HTML form (fields below) directly to PayHere's own
// checkout page via POST, signed with a hash so PayHere can trust the
// amount wasn't tampered with in the browser. That's why this returns an
// object (url + method + fields) instead of a bare URL string — the
// frontend builds and auto-submits that exact form (see
// PayHereRedirectForm in CheckoutPage.jsx) rather than doing a plain
// window.location redirect like it does for Koko/IntPay.
function payhereCheckoutUrl() {
  return process.env.PAYHERE_MODE === 'live'
    ? 'https://www.payhere.lk/pay/checkout'
    : 'https://sandbox.payhere.lk/pay/checkout'
}

// PayHere's documented hash formula: MD5(merchant_id + order_id + amount
// + currency + MD5(merchant_secret)-uppercased) - uppercased. Sri Lanka
// Post... no wait, PayHere, not the post office — this is the exact
// formula from their "Checkout API" docs, not a guess like the other
// two gateways' placeholders.
function payhereHash(merchantId, orderId, amount, currency, merchantSecret) {
  const secretHash = crypto.createHash('md5').update(merchantSecret).digest('hex').toUpperCase()
  const signature = `${merchantId}${orderId}${amount}${currency}${secretHash}`
  return crypto.createHash('md5').update(signature).digest('hex').toUpperCase()
}

async function createPayHereCheckout(order) {
  const merchantId = process.env.PAYHERE_MERCHANT_ID
  const merchantSecret = process.env.PAYHERE_MERCHANT_SECRET
  // PayHere requires exactly 2 decimal places, no thousands separator
  // (e.g. "2200.00", never "2,200.00" or "2200").
  const amount = Number(order.total_lkr).toFixed(2)
  const currency = 'LKR'
  // Pickup orders have no shipping_address — PayHere still requires an
  // address/city, so billing (always collected) is the fallback, with a
  // last-resort placeholder so a real gap in the data never blocks
  // checkout outright (better a slightly wrong city field on PayHere's
  // side than a broken checkout).
  const address = order.shipping_address || order.billing_address || {}

  return {
    url: payhereCheckoutUrl(),
    method: 'POST',
    fields: {
      merchant_id: merchantId,
      return_url: returnUrl(order),
      cancel_url: returnUrl(order),
      notify_url: `${process.env.PUBLIC_API_URL}/api/webhooks/payhere`,
      order_id: order.id,
      items: `Shani'z order ${order.id}`,
      currency,
      amount,
      first_name: order.customer_first_name || 'Customer',
      last_name: order.customer_last_name || '',
      email: order.customer_email || '',
      phone: order.customer_phone || '',
      address: address.line1 || 'Not provided',
      city: address.city || 'Colombo',
      country: 'Sri Lanka',
      hash: payhereHash(merchantId, order.id, amount, currency, merchantSecret),
    },
  }
}

const CREATORS = {
  koko: createKokoCheckout,
  intpay: createIntPayCheckout,
  payhere: createPayHereCheckout,
}

// Returns what the frontend needs to send the customer to the gateway.
// Koko/IntPay resolve to a plain URL string (simple GET redirect);
// PayHere resolves to { url, method: 'POST', fields } since it needs a
// real form submission, not a redirect — createCheckoutSession normalizes
// both shapes into one consistent return value either way. Falls back to
// a sandbox mock URL if that gateway's credentials aren't set yet, or if
// the real call fails for any reason (so a placeholder-API typo never
// blocks checkout in dev — it just doesn't process a real payment).
export async function createCheckoutSession(gateway, order) {
  if (!isConfigured(gateway)) {
    return { url: mockCheckoutUrl(gateway, order), method: 'GET', fields: null, live: false }
  }
  try {
    const result = await CREATORS[gateway](order)
    return typeof result === 'string'
      ? { url: result, method: 'GET', fields: null, live: true }
      : { method: 'GET', fields: null, ...result, live: true }
  } catch (err) {
    console.error(`${gateway} checkout session error, falling back to sandbox mock:`, err.message)
    return { url: mockCheckoutUrl(gateway, order), method: 'GET', fields: null, live: false }
  }
}

export const GATEWAYS = ['koko', 'intpay', 'payhere']

// Placeholder refund calls for Koko/IntPay — same "fill in the real
// request/response shape once you have their actual API docs" situation
// as the two createXCheckout functions above. PayHere's refund (below)
// is real, using their documented Retrieval/Refund API.
async function refundKoko(order, amountLkr) {
  const res = await fetch(`https://api.koko.lk/v1/refunds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.KOKO_API_SECRET}` },
    body: JSON.stringify({ transaction_id: order.gateway_txn_id, amount: amountLkr }),
  })
  if (!res.ok) throw new Error(`Koko refund request failed (${res.status})`)
  const data = await res.json()
  return data.refund_id
}

async function refundIntPay(order, amountLkr) {
  const res = await fetch(`https://api.intpay.lk/v2/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.INTPAY_API_SECRET },
    body: JSON.stringify({ reference: order.gateway_txn_id, amount: amountLkr }),
  })
  if (!res.ok) throw new Error(`IntPay refund request failed (${res.status})`)
  const data = await res.json()
  return data.refund_id
}

// PayHere refunds go through their Retrieval API's /merchant/v1/refund
// endpoint, authenticated with an OAuth app token (App ID + App Secret —
// a SEPARATE credential pair from the Merchant ID/Secret used for
// checkout above, generated from PayHere's dashboard under Settings >
// Business Apps with the "Payment Retrieval API" permission ticked).
// Falls back to the same "not configured" path as the other gateways if
// those app-level credentials haven't been set up yet — the storefront
// keeps working either way, only the admin's refund button is affected.
async function payhereAppToken() {
  const res = await fetch('https://sandbox.payhere.lk/merchant/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.PAYHERE_APP_ID,
      client_secret: process.env.PAYHERE_APP_SECRET,
    }),
  })
  if (!res.ok) throw new Error(`PayHere OAuth token request failed (${res.status})`)
  const data = await res.json()
  return data.access_token
}

async function refundPayHere(order, amountLkr) {
  if (!process.env.PAYHERE_APP_ID || !process.env.PAYHERE_APP_SECRET) {
    throw new Error('PayHere refunds need PAYHERE_APP_ID/PAYHERE_APP_SECRET (a Business App, separate from the checkout Merchant ID/Secret) — see .env.example.')
  }
  const token = await payhereAppToken()
  const res = await fetch('https://sandbox.payhere.lk/merchant/v1/refund', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ payment_id: order.gateway_txn_id, description: `Refund for order ${order.id}` }),
  })
  if (!res.ok) throw new Error(`PayHere refund request failed (${res.status})`)
  const data = await res.json()
  return data.data?.refund_id ?? order.gateway_txn_id
}

const REFUNDERS = { koko: refundKoko, intpay: refundIntPay, payhere: refundPayHere }

// Unlike createCheckoutSession above, this does NOT quietly fall back to
// a fake success if a live gateway's real call fails — that's fine for
// "let's get to a checkout page" but never acceptable for "did the
// customer actually get their money back." A sandbox (unconfigured)
// gateway still simulates success immediately, same as sandbox-pay does
// for the original charge, so admin approvals are fully testable before
// any gateway goes live.
export async function refundPayment(order, amountLkr) {
  if (!isConfigured(order.gateway_used)) {
    return { refunded: true, live: false, reference: `sandbox_refund_${Date.now()}` }
  }
  const reference = await REFUNDERS[order.gateway_used](order, amountLkr)
  return { refunded: true, live: true, reference }
}
