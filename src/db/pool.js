import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Managed Postgres (Neon/Supabase/Render) requires SSL in production.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
})

// Always use this instead of building SQL with string concatenation —
// $1/$2/... placeholders keep every query parameterized (spec Section 7:
// "Parameterized queries / ORM usage only — never raw string-concatenated SQL").
export function query(text, params) {
  return pool.query(text, params)
}
