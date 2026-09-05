import 'dotenv/config'
import bcrypt from 'bcrypt'
import pg from 'pg'

// Run once at first deploy: `npm run db:seed-superadmin`
// Reads credentials from environment variables only — never hardcode
// them here, never commit them (spec Section 9).

async function main() {
  const { SUPERADMIN_NAME, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD, DATABASE_URL } = process.env

  if (!SUPERADMIN_NAME || !SUPERADMIN_EMAIL || !SUPERADMIN_PASSWORD) {
    console.error('Missing SUPERADMIN_NAME / SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD in .env')
    process.exit(1)
  }
  if (SUPERADMIN_PASSWORD.length < 10) {
    console.error('SUPERADMIN_PASSWORD must be at least 10 characters.')
    process.exit(1)
  }

  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  })
  await client.connect()

  const existing = await client.query('SELECT id FROM users WHERE is_primary_superadmin = TRUE')
  if (existing.rows.length > 0) {
    console.log('A primary super admin already exists — nothing to do.')
    await client.end()
    return
  }

  const passwordHash = await bcrypt.hash(SUPERADMIN_PASSWORD, 12)
  await client.query(
    `INSERT INTO users (name, email, password_hash, role, is_primary_superadmin)
     VALUES ($1, $2, $3, 'superadmin', TRUE)`,
    [SUPERADMIN_NAME, SUPERADMIN_EMAIL, passwordHash]
  )

  console.log(`Primary super admin created: ${SUPERADMIN_EMAIL}`)
  console.log('Reminder: rotate this password after first login, and never reuse the one from .env in chat history.')
  await client.end()
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
