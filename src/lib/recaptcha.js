// Verifies a Google reCAPTCHA v2 ("I'm not a robot") token against
// Google's servers. Never trust a checkbox tick reported by the browser
// alone — a script can fake the frontend, it cannot fake this call.
//
// RECAPTCHA_SECRET_KEY is set in environment variables (see
// .env.example) — never commit the real value.

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify'

export async function verifyRecaptcha(token, remoteIp) {
  const secret = process.env.RECAPTCHA_SECRET_KEY

  // No secret configured (e.g. local dev before you've set up Google's
  // keys yet) — don't hard-fail every login for everyone on the team.
  // Logged loudly so it's never silently skipped in production by
  // accident.
  if (!secret) {
    console.warn('[recaptcha] RECAPTCHA_SECRET_KEY not set — skipping verification.')
    return true
  }

  if (!token) return false

  try {
    const params = new URLSearchParams({ secret, response: token })
    if (remoteIp) params.set('remoteip', remoteIp)

    const res = await fetch(VERIFY_URL, { method: 'POST', body: params })
    const data = await res.json()
    return data.success === true
  } catch (err) {
    // Google's service being unreachable shouldn't be indistinguishable
    // from "the visitor failed the check" in the logs.
    console.error('[recaptcha] verification request failed:', err.message)
    return false
  }
}
