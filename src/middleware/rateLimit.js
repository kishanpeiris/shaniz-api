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

// A gentler general limiter for the rest of the API.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
})
