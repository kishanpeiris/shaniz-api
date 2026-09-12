import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { logBoth } from '../lib/log.js'
import { maybeSendLowStockAlert } from '../lib/lowStockAlert.js'

const router = Router()

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

// Average rating + review count per product, joined the same way as
// units-sold above (a live subquery, not a materialized column, so a
// brand-new review shows up immediately without a background job).
const RATINGS_SUBQUERY = `
  LEFT JOIN (
    SELECT product_id, ROUND(AVG(rating), 1) AS avg_rating, COUNT(*)::int AS review_count
    FROM reviews GROUP BY product_id
  ) rev ON rev.product_id = p.id
`

// Public: browse active products. Inactive/deactivated products are
// only ever included when explicitly asked for with ?all=true AND the
// requester is an admin — the admin product-management page passes that
// flag, everything else (the Shop page, the homepage "Ritual" row,
// etc.) doesn't. This used to key off "is the requester logged in as an
// admin at all", which meant an admin browsing their own storefront
// while signed in would silently see deactivated products mixed into
// the public catalog — the exact "deactivated items still show up on
// the shop" bug this fixes.
router.get('/', async (req, res) => {
  const isAdmin = req.user && ['admin', 'superadmin'].includes(req.user.role)
  const includeInactive = isAdmin && req.query.all === 'true'
  const { rows } = await query(
    `SELECT p.id, p.name, p.description, p.name_si, p.name_ta, p.description_si, p.description_ta,
            p.price_lkr, p.stock_qty, p.category, p.category_id,
            c.name AS category_name, c.parent_id AS category_parent_id, p.badges, p.images,
            p.hover_gif_url, p.hover_video_url, p.hover_webp_url, p.detail_video_url, p.is_active,
            p.image_focal_x, p.image_focal_y,
            p.availability_mode, p.preorder_eta_days, p.created_at,
            (p.stock_qty = 0) AS out_of_stock,
            CASE
              WHEN p.stock_qty > 0 THEN 'in_stock'
              WHEN p.availability_mode = 'preorder' THEN 'preorder'
              ELSE 'out_of_stock'
            END AS availability,
            COALESCE(sold.qty, 0)::int AS units_sold,
            COALESCE(rev.avg_rating, 0)::float AS avg_rating,
            COALESCE(rev.review_count, 0) AS review_count
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     ${UNITS_SOLD_SUBQUERY}
     ${RATINGS_SUBQUERY}
     ${includeInactive ? '' : 'WHERE p.is_active = TRUE'}
     ORDER BY p.created_at DESC`
  )
  // category: resolved display name — a real category's name if one is
  // set, otherwise whatever legacy free-text value the product already
  // had (see the migration note on the categories table in schema.sql).
  res.json({ products: rows.map((r) => ({ ...r, category: r.category_name || r.category })) })
})

router.get('/:id', async (req, res) => {
  const isAdmin = req.user && ['admin', 'superadmin'].includes(req.user.role)
  const { rows } = await query(
    `SELECT p.*, c.name AS category_name, c.parent_id AS category_parent_id,
            CASE
              WHEN p.stock_qty > 0 THEN 'in_stock'
              WHEN p.availability_mode = 'preorder' THEN 'preorder'
              ELSE 'out_of_stock'
            END AS availability,
            COALESCE(rev.avg_rating, 0)::float AS avg_rating,
            COALESCE(rev.review_count, 0) AS review_count
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     ${RATINGS_SUBQUERY}
     WHERE p.id = $1 ${isAdmin ? '' : 'AND p.is_active = TRUE'}`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Product not found.' })
  const row = rows[0]
  res.json({ product: { ...row, category: row.category_name || row.category } })
})

const productSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  // Admin-typed translations (no auto-translate — see
  // SESSION-SUMMARY.md). All optional: a product with these left blank
  // just falls back to the English name/description on the storefront,
  // it never shows empty.
  name_si: z.string().optional(),
  name_ta: z.string().optional(),
  description_si: z.string().optional(),
  description_ta: z.string().optional(),
  price_lkr: z.number().nonnegative(),
  stock_qty: z.number().int().nonnegative().default(0),
  category: z.string().optional(),
  category_id: z.string().uuid().nullable().optional(),
  // No upper limit here (was previously capped at 6) — BadgesInput.jsx
  // on the frontend has no cap either, and this must match or a 7th+
  // banner would silently fail to save with a validation error. Each
  // individual banner still can't be absurdly long (max 40 chars).
  badges: z.array(z.string().min(1).max(40)).optional(),
  images: z.array(z.string().url()).optional(),
  hover_gif_url: z.string().url().optional(),
  // Preferred over hover_gif_url going forward: hover_video_url is tried
  // first on the storefront, hover_webp_url second, hover_gif_url last
  // (kept only so products uploaded before this existed keep their
  // hover effect without needing a re-upload).
  hover_video_url: z.string().url().optional(),
  hover_webp_url: z.string().url().optional(),
  // A separate, longer clip meant for the product detail page's media
  // gallery (not the hover loop) — shown alongside the photos there,
  // with the same prev/next navigation.
  detail_video_url: z.string().url().nullable().optional(),
  image_focal_x: z.number().min(0).max(100).optional(),
  image_focal_y: z.number().min(0).max(100).optional(),
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
    `INSERT INTO products (name, description, name_si, name_ta, description_si, description_ta, price_lkr, stock_qty, category, category_id, badges, images, hover_gif_url, hover_video_url, hover_webp_url, detail_video_url, availability_mode, preorder_eta_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [
      p.name,
      p.description ?? null,
      p.name_si ?? null,
      p.name_ta ?? null,
      p.description_si ?? null,
      p.description_ta ?? null,
      p.price_lkr,
      p.stock_qty,
      p.category ?? null,
      p.category_id ?? null,
      p.badges ?? [],
      p.images ?? [],
      p.hover_gif_url ?? null,
      p.hover_video_url ?? null,
      p.hover_webp_url ?? null,
      p.detail_video_url ?? null,
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

// Soft delete (deactivate) — hides the product from the storefront but
// keeps it (and its order history) intact. This is still the default
// "Delete" action in the admin UI's main list.
router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  await query('UPDATE products SET is_active = FALSE WHERE id = $1', [req.params.id])
  await logBoth(req.user.id, 'product.deactivated', req.params.id)
  res.json({ ok: true })
})

// True, permanent delete. Only allowed once a product is already
// deactivated — a deliberate two-step "deactivate, then delete" flow so
// a live product can't be destroyed with a single misclick. Safe to
// hard-delete at the database level: order line items are stored as a
// JSONB snapshot (name/qty/price at time of purchase), not a foreign key
// to this table, so removing a product row never breaks past orders.
router.delete('/:id/permanent', requireRole('admin', 'superadmin'), async (req, res) => {
  const { rows } = await query('SELECT is_active FROM products WHERE id = $1', [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Product not found.' })
  if (rows[0].is_active) {
    return res.status(400).json({ error: 'Deactivate this product first, then permanently delete it.' })
  }
  await query('DELETE FROM products WHERE id = $1', [req.params.id])
  await logBoth(req.user.id, 'product.deleted', req.params.id)
  res.json({ ok: true })
})

// Admin: stock adjustment with a dedicated endpoint (rather than a raw
// PUT) so every stock change is logged distinctly for the audit trail.
router.post('/:id/stock', requireRole('admin', 'superadmin'), async (req, res) => {
  const delta = z.number().int().safeParse(req.body?.delta)
  if (!delta.success) return res.status(400).json({ error: 'delta must be an integer.' })

  // Needed before the UPDATE so the low-stock alert can tell whether
  // this adjustment CROSSED into low stock, versus it already being low
  // (see lib/lowStockAlert.js — the latter shouldn't re-send an email).
  const before = await query('SELECT name, stock_qty FROM products WHERE id = $1', [req.params.id])
  if (!before.rows[0]) return res.status(404).json({ error: 'Product not found.' })

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

  // Fire-and-forget, after the response — a slow/failed email should
  // never delay or break the actual stock update the admin is waiting
  // on.
  maybeSendLowStockAlert({
    id: rows[0].id,
    name: before.rows[0].name,
    previousQty: before.rows[0].stock_qty,
    newQty: rows[0].stock_qty,
    threshold: rows[0].low_stock_threshold,
  }).catch((err) => console.error('[low-stock-alert] failed:', err.message))
})

export default router
