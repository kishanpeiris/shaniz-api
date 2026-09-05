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
  dialog_genie: process.env.DIALOG_GENIE_API_SECRET,
}

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
