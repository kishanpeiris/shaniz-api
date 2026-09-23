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

// True once a session is more than a few minutes old. Used by
// attachUser to decide whether to silently reissue the cookie on an
// authenticated request, turning the fixed 2-hour expiry above into a
// genuine rolling/idle timeout: someone actively using the admin panel
// (loading a page, saving, uploading an image) never hits the 2-hour
// wall, since every such request pushes it back out another 2 hours.
// Only truly stopping for 2 hours signs them out. The 5-minute floor
// just avoids re-signing/re-setting the cookie on every single request
// in a quick burst (e.g. a page that fires several GETs at once).
const REFRESH_AFTER_SECONDS = 5 * 60
export function shouldRefreshSession(payload) {
  return Date.now() / 1000 - payload.iat > REFRESH_AFTER_SECONDS
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
