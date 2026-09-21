import { Router } from 'express'
import { z } from 'zod'
import {
  OPTIONAL_EMAIL_TYPES,
  readUnsubscribeToken,
  isSuppressed,
  setSuppressed,
  maskEmail,
} from '../lib/emailPrefs.js'

// Public (no login needed): the link inside a reminder email opens the
// /unsubscribe page, which calls these. The signed token in the link is
// the proof that the request comes from that email.
const router = Router()
const tokenSchema = z.object({ token: z.string().min(10) })

function read(req, res) {
  const parsed = tokenSchema.safeParse(req.body)
  const info = parsed.success ? readUnsubscribeToken(parsed.data.token) : null
  if (!info) {
    res.status(400).json({ error: 'This link is not valid. Please use the link from the most recent email, or manage your emails in your account.' })
    return null
  }
  return info
}

// Look only — changes nothing. Lets the page say what will happen, so an
// email scanner that merely opens the link can't unsubscribe anyone.
router.post('/preview', async (req, res) => {
  const info = read(req, res)
  if (!info) return
  res.json({
    type: info.type,
    label: OPTIONAL_EMAIL_TYPES[info.type].label,
    email: maskEmail(info.email),
    unsubscribed: await isSuppressed(info.email, info.type),
  })
})

router.post('/unsubscribe', async (req, res) => {
  const info = read(req, res)
  if (!info) return
  await setSuppressed(info.email, info.type, true)
  res.json({ ok: true, label: OPTIONAL_EMAIL_TYPES[info.type].label })
})

router.post('/resubscribe', async (req, res) => {
  const info = read(req, res)
  if (!info) return
  await setSuppressed(info.email, info.type, false)
  res.json({ ok: true, label: OPTIONAL_EMAIL_TYPES[info.type].label })
})

export default router
