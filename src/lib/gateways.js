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

const isConfigured = (gateway) => {
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
