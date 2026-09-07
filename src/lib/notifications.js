import { query } from '../db/pool.js'

// Every currently-enabled superadmin's email — used for security-style
// alerts (fraud flags today; the spec's "new admin account created"
// alert can reuse this too, whenever that gets wired up).
export async function getSuperadminEmails() {
  const { rows } = await query(`SELECT email FROM users WHERE role = 'superadmin' AND disabled = FALSE`)
  return rows.map((r) => r.email)
}
