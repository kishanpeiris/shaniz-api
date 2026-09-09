import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { logBoth } from '../lib/log.js'

const router = Router()

// Public: the Shop page's category filter and the admin product/service
// forms both need this list — kept public (no requireRole) same as
// GET /api/products, since it's just names, nothing sensitive. Returns
// a flat list; the frontend groups parent/child itself (small dataset,
// no need for the server to build a tree).
router.get('/', async (req, res) => {
  const kind = z.enum(['product', 'service']).optional().safeParse(req.query.kind)
  const { rows } = await query(
    `SELECT id, kind, name, parent_id FROM categories
     ${kind.success && kind.data ? 'WHERE kind = $1' : ''}
     ORDER BY name ASC`,
    kind.success && kind.data ? [kind.data] : []
  )
  res.json({ categories: rows })
})

const categorySchema = z.object({
  kind: z.enum(['product', 'service']),
  name: z.string().min(1).max(80),
  parent_id: z.string().uuid().nullable().optional(),
})

router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = categorySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const { kind, name, parent_id } = parsed.data

  // A subcategory's parent must be a top-level category of the same
  // kind — keeps the hierarchy to a clean two levels rather than an
  // arbitrarily deep tree that the dropdown UI isn't built to show.
  if (parent_id) {
    const { rows } = await query('SELECT id, kind, parent_id FROM categories WHERE id = $1', [parent_id])
    if (!rows[0] || rows[0].kind !== kind) {
      return res.status(400).json({ error: 'Parent category not found.' })
    }
    if (rows[0].parent_id) {
      return res.status(400).json({ error: 'Subcategories can only be one level deep.' })
    }
  }

  const { rows } = await query(
    'INSERT INTO categories (kind, name, parent_id) VALUES ($1, $2, $3) RETURNING *',
    [kind, name, parent_id ?? null]
  )
  await logBoth(req.user.id, 'category.created', rows[0].id, { name, kind })
  res.status(201).json({ category: rows[0] })
})

router.put('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = z.object({ name: z.string().min(1).max(80) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  const { rows } = await query('UPDATE categories SET name = $1 WHERE id = $2 RETURNING *', [
    parsed.data.name,
    req.params.id,
  ])
  if (!rows[0]) return res.status(404).json({ error: 'Category not found.' })
  await logBoth(req.user.id, 'category.renamed', rows[0].id, { name: parsed.data.name })
  res.json({ category: rows[0] })
})

// Deleting a category never deletes the products/services in it — the
// FK is ON DELETE SET NULL, so they just fall back to uncategorized (or
// their old legacy free-text category, if they still had one). Deleting
// a parent also removes its subcategories (ON DELETE CASCADE), which in
// turn un-sets category_id on whatever was filed under those too.
router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  await query('DELETE FROM categories WHERE id = $1', [req.params.id])
  await logBoth(req.user.id, 'category.deleted', req.params.id)
  res.json({ ok: true })
})

export default router
