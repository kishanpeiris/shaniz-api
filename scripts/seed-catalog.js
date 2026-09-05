import 'dotenv/config'
import pg from 'pg'

// Seeds the real catalog the front-end expects. Safe to run more than
// once — skips anything that already exists by name.

const PRODUCTS = [
  {
    name: 'Aangraa Hair Oil',
    description:
      'For excessive hair loss, dull or thinning hair, and premature greying. Massage into the scalp for 8–10 minutes, leave 30, rinse clean.',
    price_lkr: 2450,
    stock_qty: 40,
    category: 'hair-oil',
  },
  {
    name: 'Premium Herbal Hair Mask',
    description:
      'A whole-herb soak for deep nourishment — steep, mash into a paste, and apply weekly for softer, stronger strands.',
    price_lkr: 1850,
    stock_qty: 30,
    category: 'hair-mask',
  },
]

const SERVICE = {
  name: 'Ayurvedic Scalp Ritual',
  description: 'A guided scalp massage and steam treatment using our own oil blend. Booked by appointment.',
  price_lkr: 4900,
  service_type: 'bookable',
  duration_minutes: 45,
}

async function main() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  })
  await client.connect()

  for (const p of PRODUCTS) {
    const existing = await client.query('SELECT id FROM products WHERE name = $1', [p.name])
    if (existing.rows.length) {
      console.log(`Product "${p.name}" already exists — skipping.`)
      continue
    }
    await client.query(
      `INSERT INTO products (name, description, price_lkr, stock_qty, category) VALUES ($1,$2,$3,$4,$5)`,
      [p.name, p.description, p.price_lkr, p.stock_qty, p.category]
    )
    console.log(`Created product "${p.name}"`)
  }

  let serviceId
  const existingService = await client.query('SELECT id FROM services WHERE name = $1', [SERVICE.name])
  if (existingService.rows.length) {
    serviceId = existingService.rows[0].id
    console.log(`Service "${SERVICE.name}" already exists — skipping creation.`)
  } else {
    const { rows } = await client.query(
      `INSERT INTO services (name, description, price_lkr, service_type, duration_minutes)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [SERVICE.name, SERVICE.description, SERVICE.price_lkr, SERVICE.service_type, SERVICE.duration_minutes]
    )
    serviceId = rows[0].id
    console.log(`Created service "${SERVICE.name}"`)

    // Mon–Sat, 9am–6pm, per project-spec.md's example availability.
    for (const day of [1, 2, 3, 4, 5, 6]) {
      await client.query(
        `INSERT INTO service_availability (service_id, day_of_week, start_time, end_time) VALUES ($1,$2,'09:00','18:00')`,
        [serviceId, day]
      )
    }
    console.log('Added Mon–Sat 9am–6pm availability.')
  }

  await client.end()
}

main().catch((err) => {
  console.error('Catalog seed failed:', err)
  process.exit(1)
})
