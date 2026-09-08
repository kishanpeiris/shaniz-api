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
