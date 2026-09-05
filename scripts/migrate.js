import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  })
  await client.connect()
  console.log('Applying db/schema.sql ...')
  await client.query(sql)
  console.log('Done.')
  await client.end()
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
