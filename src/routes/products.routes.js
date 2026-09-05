import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { logBoth } from '../lib/log.js'

const router = Router()

// Public: browse active products. Admins (identified via the session
// cookie, same route) also see deactivated ones, since the admin panel
// needs to manage those too.
// Units sold per product, from paid-or-further orders only (pending/cancelled
// carts shouldn't count as "popular"). Orders store line items as a JSONB
// array rather than a normalized order_items table, so this unnests that
// array and sums qty per product id. Used for the storefront's "Popularity"
// sort — kept as a subquery join (not a materialized column) so it's always
// live and never needs a background job to stay in sync.
const UNITS_SOLD_SUBQUERY = `
  LEFT JOIN (
    SELECT (item->>'id')::uuid AS product_id, SUM(COALESCE((item->>'qty')::int, 0)) AS qty
    FROM orders o, jsonb_array_elements(o.items) AS item
    WHERE o.status IN ('paid', 'shipped', 'completed') AND item->>'type' = 'product'
    GROUP BY (item->>'id')::uuid
  ) sold ON sold.product_id = p.id
`

router.get('/', async (req, res) => {
  const isAdmin = req.user && ['admin', 'superadmin'].includes(req.user.role)
  const { rows } = await query(
    `SELECT p.id, p.name, p.description, p.price_lkr, p.stock_qty, p.category, p.images, p.hover_gif_url, p.is_active,
            p.availability_mode, p.preorder_eta_days,
            (p.stock_qty = 0) AS out_of_stock,
            CASE
              WHEN p.stock_qty > 0 THEN 'in_stock'
              WHEN p.availability_mode = 'preorder' THEN 'preorder'
              ELSE 'out_of_stock'
            END AS availability,
            COALESCE(sold.qty, 0)::int AS units_sold
     FROM products p
     ${UNITS_SOLD_SUBQUERY}
     ${isAdmin ? '' : 'WHERE p.is_active = TRUE'}
     ORDER BY p.created_at DESC`
  )
  res.json({ products: rows })
})

router.get('/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT *,
            CASE
              WHEN stock_qty > 0 THEN 'in_stock'
              WHEN availability_mode = 'preorder' THEN 'preorder'
              ELSE 'out_of_stock'
            END AS availability
     FROM products WHERE id = $1 AND is_active = TRUE`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Product not found.' })
  res.json({ product: rows[0] })
})

const productSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  price_lkr: z.number().nonnegative(),
  stock_qty: z.number().int().nonnegative().default(0),
  category: z.string().optional(),
  images: z.array(z.string().url()).optional(),
  hover_gif_url: z.string().url().optional(),
  is_active: z.boolean().optional(),
  availability_mode: z.enum(['in_stock', 'out_of_stock', 'preorder']).optional(),
  preorder_eta_days: z.number().int().positive().nullable().optional(),
})

// Admin: create/edit/delete. requireRole enforces this server-side —
// hiding the button in the UI is not access control.
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = productSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const p = parsed.data

  const { rows } = await query(
    `INSERT INTO products (name, description, price_lkr, stock_qty, category, images, hover_gif_url, availability_mode, preorder_eta_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      p.name,
      p.description ?? null,
      p.price_lkr,
      p.stock_qty,
      p.category ?? null,
      p.images ?? [],
      p.hover_gif_url ?? null,
      p.availability_mode ?? 'in_stock',
      p.preorder_eta_days ?? null,
    ]
  )
  await logBoth(req.user.id, 'product.created', rows[0].id)
  res.status(201).json({ product: rows[0] })
})

router.put('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = productSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const fields = parsed.data
  const keys = Object.keys(fields)
  if (keys.length === 0) return res.status(400).json({ error: 'No fields to update.' })

  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
  const values = keys.map((k) => fields[k])
  const { rows } = await query(
    `UPDATE products SET ${setClause}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`,
    [...values, req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Product not found.' })
  await logBoth(req.user.id, 'product.updated', rows[0].id, fields)
  res.json({ product: rows[0] })
})

router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  await query('UPDATE products SET is_active = FALSE WHERE id = $1', [req.params.id])
  await logBoth(req.user.id, 'product.deactivated', req.params.id)
  res.json({ ok: true })
})

// Admin: stock adjustment with a dedicated endpoint (rather than a raw
// PUT) so every stock change is logged distinctly for the audit trail.
router.post('/:id/stock', requireRole('admin', 'superadmin'), async (req, res) => {
  const delta = z.number().int().safeParse(req.body?.delta)
  if (!delta.success) return res.status(400).json({ error: 'delta must be an integer.' })

  const { rows } = await query(
    `UPDATE products SET stock_qty = GREATEST(stock_qty + $1, 0), updated_at = now()
     WHERE id = $2 RETURNING id, stock_qty, low_stock_threshold`,
    [delta.data, req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Product not found.' })
  await logBoth(req.user.id, 'product.stock_adjusted', rows[0].id, { delta: delta.data })

  res.json({
    product: rows[0],
    low_stock: rows[0].stock_qty <= rows[0].low_stock_threshold,
  })
})

export default router
