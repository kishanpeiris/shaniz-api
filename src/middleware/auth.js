import { SESSION_COOKIE, verifySession, signSession, setSessionCookie, shouldRefreshSession } from '../lib/session.js'
import { query } from '../db/pool.js'

// Attaches req.user if a valid session cookie is present. Does not
// reject the request if there's no session — routes that require auth
// use requireAuth() below on top of this.
export async function attachUser(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE]
  if (!token) return next()

  try {
    const payload = verifySession(token)
    const { rows } = await query(
      `SELECT id, name, first_name, last_name, email, mobile, role, disabled, email_verified, language_pref, created_at, vip_discount_percent
       FROM users WHERE id = $1`,
      [payload.sub]
    )
    const user = rows[0]
    if (user && !user.disabled) {
      req.user = user
      // Rolling session: quietly extend the cookie so an admin who is
      // actively working (even just clicking around, no explicit "keep
      // me signed in" action needed) is never logged out mid-task. Only
      // real inactivity for the full 2 hours ends the session.
      if (shouldRefreshSession(payload)) {
        setSessionCookie(res, signSession(user))
      }
    }
  } catch {
    // invalid/expired token — treat as logged out, don't throw
  }
  next()
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
  next()
}

// Role-based access control, enforced server-side per spec Section 7:
// "a customer account must never be able to call admin API routes directly".
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in.' })
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized for this action.' })
    }
    next()
  }
}
