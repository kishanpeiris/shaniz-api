import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

// ---------------------------------------------------------------------
// Customer wishlist. The server only stores WHICH items are saved (type +
// id); the site looks up names, photos and prices from the normal catalog,
// so a wishlist never shows a stale price.
// ---------------------------------------------------------------------
export const customerRouter = Router()
customerRouter.use(requireAuth)

const MAX_ITEMS = 200
const itemSchema = z.object({ type: z.enum(['product', 'service']), id: z.string().uuid() })

// Only items that still exist and are on sale can be saved / listed.
async function existsActive(type, id) {
  const table = type === 'product' ? 'products' : 'services'
  const { rows } = await query(`SELECT 1 FROM ${table} WHERE id = $1 AND is_active = TRUE`, [id])
  return Boolean(rows[0])
}

async function listFor(userId) {
  const { rows } = await query(
    `SELECT w.item_type AS type, w.item_id AS id
       FROM wishlist_items w
       LEFT JOIN products p ON w.item_type = 'product' AND p.id = w.item_id
       LEFT JOIN services s ON w.item_type = 'service' AND s.id = w.item_id
      WHERE w.user_id = $1 AND (p.is_active = TRUE OR s.is_active = TRUE)
      ORDER BY w.created_at DESC`,
    [userId]
  )
  return rows
}

customerRouter.get('/', async (req, res) => {
  res.json({ items: await listFor(req.user.id) })
})

// Guest → account: adds whatever the browser had saved. Never removes
// anything, and quietly skips items that no longer exist.
customerRouter.post('/merge', async (req, res) => {
  const parsed = z.object({ items: z.array(itemSchema).max(MAX_ITEMS) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request.' })
  const { rows: countRows } = await query('SELECT count(*)::int AS n FROM wishlist_items WHERE user_id = $1', [req.user.id])
  let room = MAX_ITEMS - countRows[0].n
  for (const item of parsed.data.items) {
    if (room <= 0) break
    if (!(await existsActive(item.type, item.id))) continue
    const r = await query(
      `INSERT INTO wishlist_items (user_id, item_type, item_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [req.user.id, item.type, item.id]
    )
    room -= r.rowCount
  }
  res.json({ items: await listFor(req.user.id) })
})

customerRouter.put('/:type/:id', async (req, res) => {
  const parsed = itemSchema.safeParse({ type: req.params.type, id: req.params.id })
  if (!parsed.success) return res.status(400).json({ error: 'Invalid item.' })
  const { type, id } = parsed.data
  if (!(await existsActive(type, id))) return res.status(404).json({ error: 'That item is no longer available.' })
  const { rows } = await query('SELECT count(*)::int AS n FROM wishlist_items WHERE user_id = $1', [req.user.id])
  if (rows[0].n >= MAX_ITEMS) return res.status(400).json({ error: 'Your wishlist is full.' })
  await query(`INSERT INTO wishlist_items (user_id, item_type, item_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.user.id, type, id])
  res.json({ ok: true })
})

customerRouter.delete('/:type/:id', async (req, res) => {
  const parsed = itemSchema.safeParse({ type: req.params.type, id: req.params.id })
  if (!parsed.success) return res.status(400).json({ error: 'Invalid item.' })
  await query('DELETE FROM wishlist_items WHERE user_id = $1 AND item_type = $2 AND item_id = $3', [req.user.id, parsed.data.type, parsed.data.id])
  res.json({ ok: true })
})

// ---------------------------------------------------------------------
// Admin: which items are saved by the most customers. (Mounted behind
// requireRole('admin','superadmin') in server.js.) Counts saves by
// signed-in customers only — guest lists live in their browsers.
// ---------------------------------------------------------------------
export const adminRouter = Router()

adminRouter.get('/', async (_req, res) => {
  const { rows } = await query(
    `SELECT w.item_type AS type, w.item_id AS id, count(*)::int AS saves,
            COALESCE(p.name, s.name) AS name
       FROM wishlist_items w
       LEFT JOIN products p ON w.item_type = 'product' AND p.id = w.item_id
       LEFT JOIN services s ON w.item_type = 'service' AND s.id = w.item_id
      WHERE p.id IS NOT NULL OR s.id IS NOT NULL
      GROUP BY w.item_type, w.item_id, p.name, s.name
      ORDER BY saves DESC, name ASC
      LIMIT 10`
  )
  res.json({ items: rows })
})
