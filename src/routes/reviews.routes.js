import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'
import { logBoth } from '../lib/log.js'

const router = Router()

// Public: every review for one product, newest first, plus a small
// summary block (average rating + how many reviews at each star count —
// the same shape most star-breakdown bar UIs expect). Kept as two
// queries rather than one clever one so each stays easy to read.
router.get('/products/:productId/reviews', async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.user_id, r.rating, r.title, r.comment, r.is_verified_purchase, r.created_at,
            u.name AS author_name
     FROM reviews r
     JOIN users u ON u.id = r.user_id
     WHERE r.product_id = $1
     ORDER BY r.created_at DESC`,
    [req.params.productId]
  )

  const summary = { count: rows.length, average: 0, breakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } }
  for (const r of rows) {
    summary.breakdown[r.rating] += 1
  }
  if (rows.length > 0) {
    summary.average = rows.reduce((sum, r) => sum + r.rating, 0) / rows.length
  }

  res.json({ reviews: rows, summary })
})

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().max(120).optional(),
  comment: z.string().max(2000).optional(),
})

// Logged-in customers only, and only if they actually bought this
// product — checked against orders.items (a JSONB array, not a
// normalized order_items table — see UNITS_SOLD_SUBQUERY in
// products.routes.js for the same pattern). Any order status counts as
// "bought" here (not just paid/shipped/completed) since even a
// since-cancelled order means the product genuinely arrived in their
// basket at checkout; the badge itself is what actually matters to
// other shoppers and is fine either way.
router.post('/products/:productId/reviews', requireAuth, async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const { rating, title, comment } = parsed.data

  const purchase = await query(
    `SELECT o.id FROM orders o, jsonb_array_elements(o.items) AS item
     WHERE o.user_id = $1 AND item->>'type' = 'product' AND (item->>'id')::uuid = $2
     ORDER BY o.created_at DESC LIMIT 1`,
    [req.user.id, req.params.productId]
  )
  if (!purchase.rows[0]) {
    return res.status(403).json({ error: 'You can only review products you have purchased.' })
  }

  const existing = await query('SELECT id FROM reviews WHERE product_id = $1 AND user_id = $2', [
    req.params.productId,
    req.user.id,
  ])
  if (existing.rows[0]) {
    return res.status(409).json({ error: 'You have already reviewed this product.' })
  }

  const { rows } = await query(
    `INSERT INTO reviews (product_id, user_id, order_id, rating, title, comment, is_verified_purchase)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING *`,
    [req.params.productId, req.user.id, purchase.rows[0].id, rating, title ?? null, comment ?? null]
  )
  await logBoth(req.user.id, 'review.created', rows[0].id, { product_id: req.params.productId, rating })
  res.status(201).json({ review: { ...rows[0], author_name: req.user.name } })
})

// A customer can remove their own review; admins can remove any review
// (moderation — spam, abuse, etc.), matching the RBAC pattern used
// everywhere else (checked server-side, never just a hidden button).
router.delete('/reviews/:id', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT user_id FROM reviews WHERE id = $1', [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Review not found.' })

  const isOwner = rows[0].user_id === req.user.id
  const isAdmin = ['admin', 'superadmin'].includes(req.user.role)
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Not authorized to remove this review.' })

  await query('DELETE FROM reviews WHERE id = $1', [req.params.id])
  await logBoth(req.user.id, isAdmin && !isOwner ? 'review.moderated' : 'review.deleted', req.params.id)
  res.json({ ok: true })
})

export default router
