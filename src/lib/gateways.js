// Payment gateway abstraction — project-spec.md Section 4.
//
// Each of Koko, IntPay, and Dialog Genie exposes a hosted-checkout flow:
// you create a "checkout session" server-side, redirect the customer to
// the URL it returns, and the gateway calls your webhook
// (src/routes/webhooks.routes.js) when payment succeeds or fails.
//
// The exact request/response shape below is a best-effort placeholder —
// every gateway's real API differs, and their docs only arrive once you
// register as a merchant and get sandbox credentials (spec Section 4,
// steps 1-3). Until then, each gateway falls back to a sandbox mock URL
// so checkout keeps working end-to-end in dev. Once you have real sandbox
// docs, replace the fetch() call inside that gateway's function — the
// rest of the app (orders, webhooks, emails) doesn't need to change.

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
    dialog_genie: process.env.DIALOG_GENIE_MERCHANT_ID && process.env.DIALOG_GENIE_API_SECRET,
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

async function createDialogGenieCheckout(order) {
  // TODO: replace with Dialog Genie's real endpoint — same caveat as above.
  const res = await fetch('https://api.dialoggenie.example/v1/payment-requests', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(
        `${process.env.DIALOG_GENIE_MERCHANT_ID}:${process.env.DIALOG_GENIE_API_SECRET}`
      ).toString('base64')}`,
    },
    body: JSON.stringify({
      amount: order.total_lkr,
      currency: 'LKR',
      order_id: order.id,
      callback_url: `${process.env.PUBLIC_API_URL}/api/webhooks/dialog_genie`,
      return_url: returnUrl(order),
    }),
  })
  if (!res.ok) throw new Error(`Dialog Genie payment request failed (${res.status})`)
  const data = await res.json()
  return data.payment_url
}

const CREATORS = {
  koko: createKokoCheckout,
  intpay: createIntPayCheckout,
  dialog_genie: createDialogGenieCheckout,
}

// Returns the URL to redirect the customer to. Falls back to a sandbox
// mock URL if that gateway's credentials aren't set yet, or if the real
// call fails for any reason (so a placeholder-API typo never blocks
// checkout in dev — it just doesn't process a real payment).
export async function createCheckoutSession(gateway, order) {
  if (!isConfigured(gateway)) {
    return { url: mockCheckoutUrl(gateway, order), live: false }
  }
  try {
    const url = await CREATORS[gateway](order)
    return { url, live: true }
  } catch (err) {
    console.error(`${gateway} checkout session error, falling back to sandbox mock:`, err.message)
    return { url: mockCheckoutUrl(gateway, order), live: false }
  }
}

export const GATEWAYS = ['koko', 'intpay', 'dialog_genie']

// Placeholder refund calls — same "fill in the real request/response
// shape once you have each gateway's actual API docs" situation as the
// three createXCheckout functions above (see project-spec.md Section 4
// and .env.example). Each takes the original gateway_txn_id (captured
// when the payment first succeeded) since refunds are always issued
// against a specific transaction, never just "this order" in isolation.
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

async function refundDialogGenie(order, amountLkr) {
  const res = await fetch(`https://api.dialoggenie.lk/v1/refund`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(
        `${process.env.DIALOG_GENIE_MERCHANT_ID}:${process.env.DIALOG_GENIE_API_SECRET}`
      ).toString('base64')}`,
    },
    body: JSON.stringify({ transaction_id: order.gateway_txn_id, amount: amountLkr }),
  })
  if (!res.ok) throw new Error(`Dialog Genie refund request failed (${res.status})`)
  const data = await res.json()
  return data.refund_id
}

const REFUNDERS = { koko: refundKoko, intpay: refundIntPay, dialog_genie: refundDialogGenie }

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
