import { Router } from 'express'
import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { signSession, setSessionCookie, clearSessionCookie } from '../lib/session.js'
import { loginLimiter, passwordResetLimiter } from '../middleware/rateLimit.js'
import { logBoth, logActivity } from '../lib/log.js'
import { sendPasswordResetEmail } from '../lib/email.js'

const router = Router()

// Spec Section 7: "Minimum password strength rules (length + complexity)."
const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .regex(/[A-Z]/, 'Password needs at least one uppercase letter.')
  .regex(/[0-9]/, 'Password needs at least one number.')

const registerSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  password: passwordSchema,
})

router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message })
  }
  const { name, email, password } = parsed.data

  const existing = await query('SELECT id FROM users WHERE email = $1', [email])
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with that email already exists.' })
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'customer')
     RETURNING id, name, email, role`,
    [name, email, passwordHash]
  )
  const user = rows[0]

  const token = signSession(user)
  setSessionCookie(res, token)
  await logActivity(user.id, 'account.registered')

  res.status(201).json({ user })
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

router.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid email or password.' })
  const { email, password } = parsed.data
  const ip = req.ip

  const { rows } = await query(
    'SELECT id, name, email, password_hash, role, disabled FROM users WHERE email = $1',
    [email]
  )
  const user = rows[0]
  const valid = user ? await bcrypt.compare(password, user.password_hash) : false

  await query('INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)', [
    email,
    ip,
    Boolean(valid),
  ])

  if (!user || !valid || user.disabled) {
    if (user) {
      await logBoth(user.id, 'auth.login_failed', 'self', { ip })
    }
    return res.status(401).json({ error: 'Incorrect email or password.' })
  }

  const token = signSession(user)
  setSessionCookie(res, token)
  await logBoth(user.id, 'auth.login_success', 'self', { ip })

  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } })
})

router.post('/logout', async (req, res) => {
  clearSessionCookie(res)
  if (req.user) await logActivity(req.user.id, 'auth.logout')
  res.json({ ok: true })
})

router.get('/me', (req, res) => {
  res.json({ user: req.user ?? null })
})

// ---- Password recovery (self-service) — spec Section 7 ----
// Time-limited, single-use token emailed to the user. This route never
// reveals whether an email exists (avoids account enumeration), and
// never emails the actual password.
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  const email = z.string().email().safeParse(req.body?.email)
  if (!email.success) return res.status(400).json({ error: 'Invalid email.' })

  const { rows } = await query('SELECT id FROM users WHERE email = $1', [email.data])
  if (rows.length > 0) {
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000) // 20 minutes

    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [rows[0].id, tokenHash, expiresAt]
    )

    const resetUrl = `${process.env.FRONTEND_ORIGIN}/reset-password?token=${rawToken}`
    await sendPasswordResetEmail(email.data, resetUrl)

    // Never log the raw token in production — the email above is the only
    // place it should ever appear.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[dev only] password reset token for ${email.data}: ${rawToken}`)
    }
  }

  // Always return the same response whether or not the email existed.
  res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' })
})

const resetSchema = z.object({
  token: z.string().min(10),
  newPassword: passwordSchema,
})

router.post('/reset-password', passwordResetLimiter, async (req, res) => {
  const parsed = resetSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  const tokenHash = crypto.createHash('sha256').update(parsed.data.token).digest('hex')
  const { rows } = await query(
    `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1`,
    [tokenHash]
  )
  const record = rows[0]
  if (!record || record.used_at || new Date(record.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired.' })
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12)
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, record.user_id])
  await query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [record.id])
  await logBoth(record.user_id, 'auth.password_reset')

  res.json({ ok: true })
})

export default router
