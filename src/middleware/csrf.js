// Because auth uses an httpOnly cookie (not a bearer token the front-end
// attaches manually), state-changing requests need CSRF protection —
// spec Section 7: "CSRF protection on all state-changing requests."
//
// This uses the "custom header" pattern: browsers block cross-origin JS
// from setting custom headers without a CORS preflight, and our CORS
// config only allows FRONTEND_ORIGIN — so a forged form POST from another
// site can't add this header. Combined with SameSite=Lax cookies, this
// covers the common CSRF cases without pulling in a token-store library.
//
// For extra safety before launch, consider adding the double-submit
// token pattern (e.g. the `csrf-csrf` package) on top of this.

export function requireCsrfHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (req.get('X-Requested-With') !== 'shaniz-frontend') {
    return res.status(403).json({ error: 'Missing CSRF header.' })
  }
  next()
}
