import { SESSION_COOKIE, verifySession } from '../lib/session.js'
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
      'SELECT id, name, email, role, disabled FROM users WHERE id = $1',
      [payload.sub]
    )
    const user = rows[0]
    if (user && !user.disabled) {
      req.user = user
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
