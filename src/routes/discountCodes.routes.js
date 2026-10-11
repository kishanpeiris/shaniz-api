import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { logBoth } from '../lib/log.js'
import { effectivePrice } from '../lib/pricing.js'
import { evaluateDiscountCode, normalizeCode } from '../lib/discountCodes.js'

// ---------------------------------------------------------------------
// Public: "does this code work for my basket, and how much does it take
// off?" Used by the Apply button at checkout. It only PREVIEWS — the
// real check happens again when the order is created.
// ---------------------------------------------------------------------
export const publicRouter = Router()

const validateSchema = z.object({
  code: z.string().min(1).max(40),
  items: z.array(z.object({ type: z.enum(['product', 'service']), id: z.string().uuid(), qty: z.number().int().positive() })).min(1),
  email: z.string().email().optional(),
})

publicRouter.post('/validate', async (req, res) => {
  const parsed = validateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request.' })
  const { code, items, email } = parsed.data

  // Work out the subtotal from the database, never from browser prices.
  let subtotal = 0
  for (const item of items) {
    const table = item.type === 'product' ? 'products' : 'services'
    const { rows } = await query(
      `SELECT price_lkr, discount_type, discount_value, discount_starts_at, discount_ends_at FROM ${table} WHERE id = $1 AND is_active = TRUE`,
      [item.id]
    )
    if (rows[0]) subtotal += effectivePrice(rows[0]) * item.qty
  }

  const vipPercent = Number(req.user?.vip_discount_percent ?? 0)
  const vipDiscountLkr = Math.round(subtotal * (vipPercent / 100))

  const result = await evaluateDiscountCode({ query }, {
    code,
    subtotal,
    vipDiscountLkr,
    userId: req.user?.id ?? null,
    email: req.user?.email ?? email ?? null,
  })

  if (!result.ok) return res.json({ valid: false, reason: result.reason, min_subtotal_lkr: result.min_subtotal_lkr })
  const c = result.codeRow
  res.json({
    valid: true,
    code: c.code,
    discount_type: c.discount_type,
    discount_value: Number(c.discount_value),
    discount_lkr: result.discountLkr,
  })
})

// ---------------------------------------------------------------------
// Admin: create / list / switch on-off / delete codes.
// (Mounted behind requireRole('admin','superadmin') in server.js.)
// ---------------------------------------------------------------------
export const adminRouter = Router()

const SELECT_CODES = `
  SELECT dc.id, dc.code, dc.description, dc.discount_type, dc.discount_value, dc.min_subtotal_lkr,
         dc.max_total_uses, dc.one_per_customer, dc.is_active, dc.created_at,
         CASE WHEN dc.expires_at IS NULL THEN NULL
              ELSE to_char((dc.expires_at AT TIME ZONE 'Asia/Colombo') - interval '1 second', 'YYYY-MM-DD') END AS expires_on,
         (dc.expires_at IS NOT NULL AND dc.expires_at <= now()) AS is_expired,
         (SELECT count(*)::int FROM orders o WHERE o.discount_code_id = dc.id
            AND (o.status IN ('paid','shipped','completed') OR (o.status = 'pending' AND o.created_at > now() - interval '45 minutes'))) AS times_used
    FROM discount_codes dc`

adminRouter.get('/', async (_req, res) => {
  const { rows } = await query(`${SELECT_CODES} ORDER BY dc.created_at DESC`)
  res.json({ codes: rows })
})

const createSchema = z
  .object({
    code: z.string().transform(normalizeCode).pipe(z.string().regex(/^[A-Z0-9_-]{3,32}$/, 'Code must be 3–32 letters, numbers, - or _.')),
    description: z.string().max(200).optional().nullable(),
    discount_type: z.enum(['percent', 'fixed']),
    discount_value: z.number().positive(),
    min_subtotal_lkr: z.number().min(0).optional().default(0),
    expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date.').optional().nullable(),
    max_total_uses: z.number().int().positive().optional().nullable(),
    one_per_customer: z.boolean().optional().default(true),
  })
  .refine((d) => d.discount_type !== 'percent' || d.discount_value <= 100, {
    message: 'A percentage discount cannot be more than 100%.',
    path: ['discount_value'],
  })

adminRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })
  const d = parsed.data

  const dup = await query('SELECT 1 FROM discount_codes WHERE upper(code) = $1', [d.code])
  if (dup.rows[0]) return res.status(409).json({ error: 'A code with that name already exists.' })

  // "Expires on 2026-12-31" means valid through the end of that day in Sri Lanka.
  const { rows } = await query(
    `INSERT INTO discount_codes (code, description, discount_type, discount_value, min_subtotal_lkr, expires_at, max_total_uses, one_per_customer)
     VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::date IS NULL THEN NULL ELSE (($6::date + 1)::timestamp AT TIME ZONE 'Asia/Colombo') END, $7, $8)
     RETURNING id`,
    [d.code, d.description || null, d.discount_type, d.discount_value, d.min_subtotal_lkr, d.expires_on || null, d.max_total_uses ?? null, d.one_per_customer]
  )
  await logBoth(req.user.id, 'discount_code.created', rows[0].id, { code: d.code })
  const created = await query(`${SELECT_CODES} WHERE dc.id = $1`, [rows[0].id])
  res.status(201).json({ code: created.rows[0] })
})

adminRouter.put('/:id', async (req, res) => {
  const parsed = z.object({ is_active: z.boolean() }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request.' })
  const { rows } = await query('UPDATE discount_codes SET is_active = $1 WHERE id = $2 RETURNING id, code', [parsed.data.is_active, req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Code not found.' })
  await logBoth(req.user.id, parsed.data.is_active ? 'discount_code.activated' : 'discount_code.deactivated', rows[0].id, { code: rows[0].code })
  res.json({ ok: true })
})

// Codes that have ever been used stay (so past orders/usage counts stay
// accurate) — the admin deactivates those instead.
adminRouter.delete('/:id', async (req, res) => {
  const used = await query('SELECT 1 FROM orders WHERE discount_code_id = $1 LIMIT 1', [req.params.id])
  if (used.rows[0]) return res.status(409).json({ error: 'This code has been used on an order, so it can’t be deleted. Turn it off instead.' })
  const { rows } = await query('DELETE FROM discount_codes WHERE id = $1 RETURNING id, code', [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Code not found.' })
  await logBoth(req.user.id, 'discount_code.deleted', rows[0].id, { code: rows[0].code })
  res.json({ ok: true })
})
