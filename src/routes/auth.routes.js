import { Router } from 'express'
import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { signSession, setSessionCookie, clearSessionCookie } from '../lib/session.js'
import { loginLimiter, passwordResetLimiter, verificationLimiter } from '../middleware/rateLimit.js'
import { logBoth, logActivity } from '../lib/log.js'
import { sendPasswordResetEmail, sendVerificationEmail } from '../lib/email.js'
import { serializeUser } from '../lib/serializeUser.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// Spec Section 7: "Minimum password strength rules (length + complexity)."
const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .regex(/[A-Z]/, 'Password needs at least one uppercase letter.')
  .regex(/[0-9]/, 'Password needs at least one number.')

// lastName is optional — some people go by a single (mononym) name, and
// we never want to force a fake surname just to satisfy a form.
const registerSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100).optional(),
  email: z.string().email(),
  password: passwordSchema,
  mobile: z.string().min(7).max(20).optional(),
})

// Creates a random, single-use, time-limited token; stores only its hash
// (same pattern as the password-reset flow below) and emails the raw
// token to the user. Returns nothing — the email send is fire-and-forget
// from the caller's perspective, matching how password reset works.
async function issueVerificationEmail(user) {
  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours

  await query(
    `INSERT INTO email_verify_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt]
  )

  const verifyUrl = `${process.env.FRONTEND_ORIGIN}/verify-email?token=${rawToken}`
  await sendVerificationEmail(user.email, verifyUrl)

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[dev only] email verify token for ${user.email}: ${rawToken}`)
  }
}

router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message })
  }
  const { firstName, lastName, password, mobile } = parsed.data
  // Lowercase up front so "A@x.com" and "a@x.com" are always treated as
  // the same address — matches the case-insensitive unique index in
  // db/schema.sql (defense in depth: both layers enforce this).
  const email = parsed.data.email.toLowerCase()

  const blacklisted = await query('SELECT id FROM blacklisted_emails WHERE LOWER(email) = $1', [email])
  if (blacklisted.rows.length > 0) {
    // Deliberately vague — never confirm that this specific address was blocked.
    return res.status(403).json({ error: 'This email address cannot be used to register.' })
  }

  const existing = await query('SELECT id FROM users WHERE LOWER(email) = $1', [email])
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with that email already exists.' })
  }

  const name = lastName ? `${firstName} ${lastName}` : firstName
  const passwordHash = await bcrypt.hash(password, 12)
  const { rows } = await query(
    `INSERT INTO users (name, first_name, last_name, email, mobile, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, $6, 'customer')
     RETURNING id, name, first_name, last_name, email, mobile, role, email_verified, language_pref, disabled, created_at`,
    [name, firstName, lastName ?? null, email, mobile ?? null, passwordHash]
  )
  const user = rows[0]

  const token = signSession(user)
  setSessionCookie(res, token)
  await logActivity(user.id, 'account.registered')
  await issueVerificationEmail(user)

  res.status(201).json({ user: serializeUser(user) })
})

// Requires being logged in (but not yet verified) — lets someone whose
// first email got lost or expired ask for a fresh one, without needing
// their password again.
router.post('/resend-verification', requireAuth, verificationLimiter, async (req, res) => {
  if (req.user.email_verified) {
    return res.json({ ok: true, message: 'This email is already verified.' })
  }
  await issueVerificationEmail(req.user)
  res.json({ ok: true, message: 'Verification email sent.' })
})

// Clicked from the emailed link. GET is intentional here (same shape as
// most "confirm your email" links): the token itself is the secret, it's
// single-use, and it only ever affects the one account it was issued to.
router.get('/verify-email', async (req, res) => {
  const parsed = z.string().min(10).safeParse(req.query.token)
  if (!parsed.success) return res.status(400).json({ error: 'Missing or invalid token.' })

  const tokenHash = crypto.createHash('sha256').update(parsed.data).digest('hex')
  const { rows } = await query(
    `SELECT id, user_id, expires_at, used_at FROM email_verify_tokens WHERE token_hash = $1`,
    [tokenHash]
  )
  const record = rows[0]
  if (!record || record.used_at || new Date(record.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This verification link is invalid or has expired.' })
  }

  await query('UPDATE users SET email_verified = TRUE WHERE id = $1', [record.user_id])
  await query('UPDATE email_verify_tokens SET used_at = now() WHERE id = $1', [record.id])
  await logActivity(record.user_id, 'account.email_verified')

  res.json({ ok: true })
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

router.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid email or password.' })
  const email = parsed.data.email.toLowerCase()
  const { password } = parsed.data
  const ip = req.ip

  const { rows } = await query(
    `SELECT id, name, first_name, last_name, email, mobile, password_hash, role, disabled, email_verified, language_pref, created_at
     FROM users WHERE LOWER(email) = $1`,
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

  res.json({ user: serializeUser(user) })
})

router.post('/logout', async (req, res) => {
  clearSessionCookie(res)
  if (req.user) await logActivity(req.user.id, 'auth.logout')
  res.json({ ok: true })
})

router.get('/me', (req, res) => {
  res.json({ user: req.user ? serializeUser(req.user) : null })
})

// ---- Password recovery (self-service) — spec Section 7 ----
// Time-limited, single-use token emailed to the user. This route never
// reveals whether an email exists (avoids account enumeration), and
// never emails the actual password.
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  const parsedEmail = z.string().email().safeParse(req.body?.email)
  if (!parsedEmail.success) return res.status(400).json({ error: 'Invalid email.' })
  const email = { data: parsedEmail.data.toLowerCase() }

  const { rows } = await query('SELECT id FROM users WHERE LOWER(email) = $1', [email.data])
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
