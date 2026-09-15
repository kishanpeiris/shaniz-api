import rateLimit from 'express-rate-limit'

// Spec Section 7: "Rate limiting on login attempts (e.g. lock/delay after
// 5 failed attempts) to block brute-force attacks."
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
})

export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset requests. Try again later.' },
})

// Same shape as passwordResetLimiter, kept separate so tightening one
// doesn't accidentally tighten the other.
export const verificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification requests. Try again later.' },
})

// Admin-triggered "resend activation email" (Customers page). Kept apart
// from the customer-facing verificationLimiter above (which is keyed by
// IP and meant to stop one abusive visitor spamming themselves) — an
// admin working through a list of customers from the same office IP
// shouldn't get boxed in by that. Keyed by the admin's own user id
// instead of IP, with a looser limit since it's already gated by
// requireRole('admin','superadmin').
export const adminResendVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Too many resend requests. Try again in a few minutes.' },
})

// The homepage contact form (Visit.jsx) — public and unauthenticated,
// so it needs its own limit distinct from the general apiLimiter to
// stop it being used to spam the business's inbox.
export const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages sent. Please try again later.' },
})

// Address-line autocomplete (checkout, account) fires roughly once per
// keystroke pause, so it needs more headroom than a form-submit limiter
// like contactLimiter — but it's still a public, unauthenticated route
// backed by a metered third-party API (LocationIQ), so it isn't left
// wide open either. 40 lookups/5 min per IP comfortably covers someone
// filling out an address a few times (typos, address changes) without
// meaningfully exposing the LocationIQ quota to abuse.
export const addressAutocompleteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many address lookups. Please slow down a little.' },
})

// A gentler general limiter for the rest of the API.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
})
