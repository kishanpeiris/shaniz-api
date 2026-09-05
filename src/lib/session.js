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
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, // never readable from JS — spec Section 7
    secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
    sameSite: 'lax',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  })
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' })
}

export { SESSION_COOKIE }
