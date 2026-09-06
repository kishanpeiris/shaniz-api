import jwt from 'jsonwebtoken'

const SESSION_COOKIE = 'shaniz_session'
const SESSION_TTL_SECONDS = 60 * 60 * 2 // 2 hours of inactivity — spec Section 7

export function signSession(user) {
  return jwt.sign(
    { sub: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: SESSION_TTL_SECONDS }
  )
}

export function verifySession(token) {
  return jwt.verify(token, process.env.JWT_SECRET)
}

export function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production'
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, // never readable from JS — spec Section 7
    secure: isProd, // HTTPS only in prod
    // 'none' is required in production because the frontend
    // (*.vercel.app) and backend (*.onrender.com) are on different
    // domains until a shared custom domain is set up (deployment guide
    // Step 8) — SameSite=Lax cookies are never sent on cross-site
    // fetch/XHR calls, only on top-level navigations, which is why the
    // login response worked but every subsequent API call looked
    // signed-out. 'none' requires Secure, which is already true in
    // prod. Locally, frontend/backend both run on localhost (different
    // ports are still same-site for cookie purposes there), so 'lax'
    // is fine and doesn't require HTTPS.
    sameSite: isProd ? 'none' : 'lax',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  })
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' })
}

export { SESSION_COOKIE }
