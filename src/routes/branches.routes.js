import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { logBoth } from '../lib/log.js'

const router = Router()

// Public — used to show "where is this service" on the storefront, and
// to populate the branch picker on the admin Services form. Nothing
// here is sensitive (name/address/phone are meant to be public anyway).
router.get('/', async (req, res) => {
  const { rows } = await query('SELECT * FROM branches ORDER BY name')
  res.json({ branches: rows })
})

// "Find coordinates from this address" — used by the admin branch form
// so admins don't have to hunt down lat/long manually.
//
// Primary: LocationIQ (https://locationiq.com) — free tier (5,000
// requests/day, no credit card), and its /search endpoint returns the
// exact same lat/lon/display_name shape as Nominatim, so no other code
// needed to change. Falls back to OpenStreetMap's Nominatim (no key at
// all) when GEOCODING_API_KEY isn't set, so this still works out of the
// box for local dev / anyone who hasn't signed up yet.
//
// Why not just Nominatim for production too: its public demo server is
// meant for light, non-commercial use and actively rate-limits/blocks
// requests from shared cloud-hosting IP ranges (Render/Railway/Vercel
// all draw from pools other Nominatim users have already gotten
// throttled) — the exact "Geocoding service returned an error" failure
// this was hitting. LocationIQ's free tier is normal API-key access, no
// such shared-IP penalty.
async function geocodeWithLocationIQ(address, apiKey) {
  const url = `https://us1.locationiq.com/v1/search?key=${apiKey}&format=json&limit=1&q=${encodeURIComponent(address)}`
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    console.error('[geocode] LocationIQ error', response.status, body)
    throw new Error(`LocationIQ returned ${response.status}`)
  }
  return body
}

async function geocodeWithNominatim(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ShanizAdminPanel/1.0 (branch location lookup)',
      Accept: 'application/json',
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    console.error('[geocode] Nominatim error', response.status, body)
    throw new Error(`Nominatim returned ${response.status}`)
  }
  return body
}

router.get('/geocode', requireRole('admin', 'superadmin'), async (req, res) => {
  const address = z.string().min(1).safeParse(req.query.address)
  if (!address.success) return res.status(400).json({ error: 'address is required.' })

  const apiKey = process.env.GEOCODING_API_KEY

  let results
  try {
    results = apiKey ? await geocodeWithLocationIQ(address.data, apiKey) : await geocodeWithNominatim(address.data)
  } catch (primaryErr) {
    // If the paid-tier-free key is configured but that call itself
    // failed (network blip, quota briefly exceeded), Nominatim is worth
    // one attempt before giving up entirely.
    if (apiKey) {
      try {
        results = await geocodeWithNominatim(address.data)
      } catch (fallbackErr) {
        console.error('[geocode] both providers failed:', primaryErr.message, fallbackErr.message)
        return res.status(502).json({
          error: 'Geocoding service returned an error. You can place the pin on the map manually instead.',
        })
      }
    } else {
      console.error('[geocode] failed:', primaryErr.message)
      return res.status(502).json({
        error:
          'Geocoding service returned an error — this free lookup occasionally gets rate-limited on shared hosting. Add a free LocationIQ API key (GEOCODING_API_KEY) for reliable results, or place the pin on the map manually.',
      })
    }
  }

  if (!results?.[0]) return res.status(404).json({ error: 'No location found for that address — try adding more detail (city, country), or place the pin manually on the map.' })

  res.json({ latitude: Number(results[0].lat), longitude: Number(results[0].lon), display_name: results[0].display_name })
})

const branchSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  phone: z.string().optional(),
})

router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = branchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const b = parsed.data

  const { rows } = await query(
    `INSERT INTO branches (name, address, latitude, longitude, phone) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.name, b.address, b.latitude ?? null, b.longitude ?? null, b.phone ?? null]
  )
  await logBoth(req.user.id, 'branch.created', rows[0].id)
  res.status(201).json({ branch: rows[0] })
})

router.put('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = branchSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const fields = parsed.data
  const keys = Object.keys(fields)
  if (keys.length === 0) return res.status(400).json({ error: 'Nothing to update.' })

  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
  const { rows } = await query(
    `UPDATE branches SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
    [...keys.map((k) => fields[k]), req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Branch not found.' })
  await logBoth(req.user.id, 'branch.updated', rows[0].id)
  res.json({ branch: rows[0] })
})

router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  // Services pointing at this branch just lose their location (ON
  // DELETE SET NULL in the schema) rather than being blocked or deleted
  // themselves — a branch closing shouldn't take services down with it.
  await query('DELETE FROM branches WHERE id = $1', [req.params.id])
  await logBoth(req.user.id, 'branch.deleted', req.params.id)
  res.json({ ok: true })
})

export default router
