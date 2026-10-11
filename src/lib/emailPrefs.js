import jwt from 'jsonwebtoken'
import { query } from '../db/pool.js'

// Optional (marketing-style) emails a customer can switch off. Everything
// else the site sends — order confirmations, shipping notices, invoices,
// booking confirmations/changes, password reset, email verification — is
// transactional: the customer needs it to use the service, so it is
// always sent.
export const OPTIONAL_EMAIL_TYPES = {
  cart_reminders: {
    label: 'Basket reminders',
    description: 'One friendly reminder if you leave items in your basket for 3 days.',
  },
  wishlist_reminders: {
    label: 'Wishlist reminder',
    description: 'One friendly email if items you saved to your wishlist are still waiting after a week.',
  },
  checkout_reminders: {
    label: 'Checkout reminders',
    description: 'One reminder if you start checkout but the payment is never completed.',
  },
  booking_reminders: {
    label: 'Booking reminders',
    description: 'A reminder the day before an appointment you have booked.',
  },
}

export const ALWAYS_SENT_EMAILS = [
  'Order confirmations, shipping updates and invoices',
  'Booking confirmations and changes to a booking',
  'Password reset and email verification (account security)',
]

const norm = (email) => String(email).trim().toLowerCase()

export async function isSuppressed(email, type) {
  const { rows } = await query('SELECT 1 FROM email_suppressions WHERE email = $1 AND type = $2', [norm(email), type])
  return rows.length > 0
}

export async function suppressedTypes(email) {
  const { rows } = await query('SELECT type FROM email_suppressions WHERE email = $1', [norm(email)])
  return new Set(rows.map((r) => r.type))
}

export async function setSuppressed(email, type, suppressed) {
  if (!OPTIONAL_EMAIL_TYPES[type]) throw new Error('Unknown email type.')
  if (suppressed) {
    await query('INSERT INTO email_suppressions (email, type) VALUES ($1, $2) ON CONFLICT DO NOTHING', [norm(email), type])
  } else {
    await query('DELETE FROM email_suppressions WHERE email = $1 AND type = $2', [norm(email), type])
  }
}

// A signed link token: it proves the link came from an email we sent, so
// nobody can unsubscribe a stranger by guessing an address. No expiry —
// an unsubscribe link in an old email should keep working.
export function unsubscribeToken(email, type) {
  return jwt.sign({ e: norm(email), t: type }, process.env.JWT_SECRET, { audience: 'email-unsubscribe' })
}

export function readUnsubscribeToken(token) {
  try {
    const p = jwt.verify(String(token), process.env.JWT_SECRET, { audience: 'email-unsubscribe' })
    if (!OPTIONAL_EMAIL_TYPES[p.t]) return null
    return { email: p.e, type: p.t }
  } catch {
    return null
  }
}

export const unsubscribeUrl = (email, type) =>
  `${process.env.FRONTEND_ORIGIN}/unsubscribe?token=${encodeURIComponent(unsubscribeToken(email, type))}`

export const maskEmail = (email) => {
  const [name, domain] = norm(email).split('@')
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`
}
