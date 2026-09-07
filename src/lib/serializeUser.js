// Every place that sends a user object to the frontend (register, login,
// /me, profile update) should run it through this function first. Before
// this existed, each route hand-built its own `{ id, name, email, role }`
// object slightly differently, which is how a page refresh could silently
// lose fields like `emailVerified` — one route's shape had it, another's
// didn't, and the frontend had no way to tell "missing" apart from "false".
//
// Input: a raw Postgres row (snake_case columns). Output: one fixed,
// camelCase shape every frontend page can rely on.
export function serializeUser(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    email: row.email,
    mobile: row.mobile ?? null,
    role: row.role,
    emailVerified: Boolean(row.email_verified),
    disabled: Boolean(row.disabled),
    createdAt: row.created_at ?? null,
  }
}
