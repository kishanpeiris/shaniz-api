import { Router } from 'express'
import crypto from 'crypto'
import { query } from '../db/pool.js'
import { logAudit } from '../lib/log.js'
import { sendInvoiceEmail } from '../lib/email.js'

const router = Router()

// Spec Section 7: "Webhook signature verification for every gateway
// callback — reject unsigned/forged payment confirmations."
//
// Each gateway signs webhooks differently — this is a placeholder HMAC
// check. Replace the signature logic per gateway once you have their
// webhook docs (you'll get these along with sandbox credentials).
function verifySignature(gateway, rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  } catch {
    return false // length mismatch etc. — treat as invalid, not a crash
  }
}

const SECRETS = {
  koko: process.env.KOKO_API_SECRET,
  intpay: process.env.INTPAY_API_SECRET,
}

// PayHere's notify_url callback is structurally different from the
// generic placeholder handler below (Koko/IntPay): it POSTs regular
// form fields (application/x-www-form-urlencoded), not JSON, and signs
// with MD5 over specific named fields rather than an HMAC over the raw
// body — so it gets its own dedicated route instead of sharing the
// generic /:gateway handler. Registered before that generic route so
// Express matches this one first for exactly this path.
//
// Verification formula (PayHere's docs): the merchant recomputes
// md5sig from the fields PayHere sent + the merchant secret, and it
// must match what PayHere actually sent — this is what stops someone
// forging a "payment succeeded" callback with a fake order/amount.
router.post('/payhere', async (req, res) => {
  const merchantSecret = process.env.PAYHERE_MERCHANT_SECRET
  if (!merchantSecret) return res.status(404).json({ error: 'PayHere is not configured.' })

  // req.body is the raw request Buffer (see server.js) regardless of
  // content-type, so form-urlencoded needs parsing here rather than
  // relying on Express's usual body parser (which isn't in the chain
  // for this path — see the express.raw() note in server.js).
  const params = new URLSearchParams(req.body.toString('utf8'))
  const merchantId = params.get('merchant_id')
  const orderId = params.get('order_id')
  const payhereAmount = params.get('payhere_amount')
  const payhereCurrency = params.get('payhere_currency')
  const statusCode = params.get('status_code')
  const receivedSig = params.get('md5sig')

  if (!merchantId || !orderId || !payhereAmount || !payhereCurrency || !statusCode || !receivedSig) {
    return res.status(400).json({ error: 'Missing required PayHere notify fields.' })
  }

  const secretHash = crypto.createHash('md5').update(merchantSecret).digest('hex').toUpperCase()
  const expectedSig = crypto
    .createHash('md5')
    .update(`${merchantId}${orderId}${payhereAmount}${payhereCurrency}${statusCode}${secretHash}`)
    .digest('hex')
    .toUpperCase()

  if (expectedSig !== receivedSig.toUpperCase()) {
    await logAudit(null, 'webhook.rejected_invalid_signature', 'payhere', { ip: req.ip, order_id: orderId })
    return res.status(401).json({ error: 'Invalid webhook signature.' })
  }

  // PayHere status_code: 2 = success, 0 = pending, -1 = cancelled,
  // -2 = failed, -3 = charged back. Pending/unrecognized codes are
  // acknowledged (200) without changing order status — PayHere retries
  // notify_url on non-2xx responses, and a "pending" isn't an error on
  // our end, just not a final answer yet.
  const mappedStatus = statusCode === '2' ? 'paid' : statusCode === '-1' || statusCode === '-2' ? 'cancelled' : null
  if (!mappedStatus) {
    await logAudit(null, 'webhook.payhere.pending_or_unrecognized', orderId, { status_code: statusCode })
    return res.json({ ok: true })
  }

  const paymentId = params.get('payment_id') // PayHere's transaction reference, needed later for refunds
  const { rows } = await query(
    `UPDATE orders SET status = $1, gateway_txn_id = COALESCE($2, gateway_txn_id), updated_at = now() WHERE id = $3 RETURNING *`,
    [mappedStatus, paymentId, orderId]
  )
  await logAudit(null, `webhook.payhere.${mappedStatus}`, orderId, { status_code: statusCode, payment_id: paymentId })

  const order = rows[0]
  if (order && mappedStatus === 'paid') {
    const recipientEmail =
      order.guest_email ??
      (order.user_id
        ? (await query('SELECT email FROM users WHERE id = $1', [order.user_id])).rows[0]?.email
        : null)
    if (recipientEmail) await sendInvoiceEmail(order, recipientEmail, null)
  }

  // PayHere expects a plain 200 OK — no JSON body required, but an
  // object is harmless and matches the other webhook handlers below.
  res.json({ ok: true })
})

router.post('/:gateway', async (req, res) => {
  const gateway = req.params.gateway
  if (!(gateway in SECRETS)) return res.status(404).json({ error: 'Unknown gateway.' })

  const signature = req.get('X-Signature') // header name varies per gateway — adjust per their docs
  // req.body is the raw request Buffer (see server.js) — verify the
  // signature against these exact bytes, not a re-serialized copy.
  const rawBody = req.body

  const valid = verifySignature(gateway, rawBody, signature, SECRETS[gateway])
  if (!valid) {
    await logAudit(null, 'webhook.rejected_invalid_signature', gateway, { ip: req.ip })
    return res.status(401).json({ error: 'Invalid webhook signature.' })
  }

  let payload
  try {
    payload = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'Malformed JSON body.' })
  }

  // Expected shape will differ per gateway — normalize it here once you
  // have real payload examples from their sandbox.
  const { order_id, transaction_id, status } = payload

  const mappedStatus = status === 'success' ? 'paid' : status === 'failed' ? 'cancelled' : null
  if (!order_id || !mappedStatus) {
    return res.status(400).json({ error: 'Unrecognized webhook payload.' })
  }

  const { rows } = await query(
    `UPDATE orders SET status = $1, gateway_txn_id = $2, updated_at = now() WHERE id = $3 RETURNING *`,
    [mappedStatus, transaction_id ?? null, order_id]
  )
  await logAudit(null, `webhook.${gateway}.${mappedStatus}`, order_id, { transaction_id })

  const order = rows[0]
  if (order && mappedStatus === 'paid') {
    const recipientEmail =
      order.guest_email ??
      (order.user_id
        ? (await query('SELECT email FROM users WHERE id = $1', [order.user_id])).rows[0]?.email
        : null)
    if (recipientEmail) await sendInvoiceEmail(order, recipientEmail, null)
  }

  res.json({ ok: true })
})

export default router
