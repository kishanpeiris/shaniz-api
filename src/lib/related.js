import { query } from '../db/pool.js'
import { withSalePrice } from './pricing.js'
import { branchesByService } from './branches.js'

// "You might also like" — shown on product and service detail pages.
//
// Products and services each have their OWN "Hair Care" category row
// (see the `kind` column on the categories table in schema.sql) — a
// product's category_id and a service's category_id never point at the
// same row even when the name matches. So cross-type matching here is
// done by category NAME, not category_id: "products whose resolved
// category name equals this service's category name", and vice versa.
// Matching within one type (product-to-product) still effectively
// compares the same thing, just via the same name.
//
// Ranked by how many have sold. If a category is new, small, or the item
// has no category at all, the row is topped up with the site's overall
// best-sellers so a customer never sees an empty or half-empty rail.
const TARGET = 4

const PRODUCT_COLUMNS = `
  p.id, p.name, p.name_si, p.name_ta, p.price_lkr, p.category_id,
  COALESCE(c.name, p.category) AS category_name, c.parent_id AS category_parent_id,
  p.discount_type, p.discount_value, p.discount_starts_at, p.discount_ends_at,
  p.badges, p.images, p.hover_gif_url, p.hover_video_url, p.hover_webp_url,
  p.image_focal_x, p.image_focal_y, p.availability_mode, p.preorder_eta_days,
  (p.stock_qty = 0) AS out_of_stock,
  CASE WHEN p.stock_qty > 0 THEN 'in_stock' WHEN p.availability_mode = 'preorder' THEN 'preorder' ELSE 'out_of_stock' END AS availability,
  COALESCE(sold.qty, 0)::int AS units_sold`

const SERVICE_COLUMNS = `
  s.id, s.name, s.name_si, s.name_ta, s.price_lkr, s.service_type, s.duration_minutes,
  s.category_id, c.name AS category_name, c.parent_id AS category_parent_id,
  s.discount_type, s.discount_value, s.discount_starts_at, s.discount_ends_at,
  s.badges, s.images, s.hover_gif_url, s.hover_video_url, s.hover_webp_url,
  s.image_focal_x, s.image_focal_y, s.branch_id,
  COALESCE(sold.qty, 0)::int AS units_sold`

const PRODUCT_SOLD_JOIN = `
  LEFT JOIN (
    SELECT (item->>'id')::uuid AS product_id, SUM(COALESCE((item->>'qty')::int, 0)) AS qty
    FROM orders o, jsonb_array_elements(o.items) AS item
    WHERE o.status IN ('paid', 'shipped', 'completed') AND item->>'type' = 'product'
    GROUP BY (item->>'id')::uuid
  ) sold ON sold.product_id = p.id`

const SERVICE_SOLD_JOIN = `
  LEFT JOIN (
    SELECT (item->>'id')::uuid AS service_id, SUM(COALESCE((item->>'qty')::int, 0)) AS qty
    FROM orders o, jsonb_array_elements(o.items) AS item
    WHERE o.status IN ('paid', 'shipped', 'completed') AND item->>'type' = 'service'
    GROUP BY (item->>'id')::uuid
  ) sold ON sold.service_id = s.id`

// Resolve the display category name for one item, the same way the list
// endpoints do (a real category's name if set, else the legacy free-text
// value) — this is what cross-type matching compares.
export async function resolveCategoryName(type, id) {
  const table = type === 'product' ? 'products' : 'services'
  const alias = type === 'product' ? 'p' : 's'
  // Only products kept a legacy free-text `category` column from before
  // the categories table existed (see schema.sql) — services never had one.
  const nameExpr = type === 'product' ? `COALESCE(c.name, ${alias}.category)` : 'c.name'
  const { rows } = await query(
    `SELECT ${nameExpr} AS name
       FROM ${table} ${alias}
       LEFT JOIN categories c ON c.id = ${alias}.category_id
      WHERE ${alias}.id = $1 AND ${alias}.is_active = TRUE`,
    [id]
  )
  return rows[0]?.name || null
}

async function fetchProducts({ categoryName, excludeId, limit, excludeIds = [] }) {
  if (limit <= 0) return []
  const { rows } = await query(
    `SELECT ${PRODUCT_COLUMNS}
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${PRODUCT_SOLD_JOIN}
      WHERE p.is_active = TRUE AND p.id <> $1 AND NOT (p.id = ANY($2::uuid[]))
        AND (p.stock_qty > 0 OR p.availability_mode = 'preorder')
        AND ($3::text IS NULL OR COALESCE(c.name, p.category) ILIKE $3)
      ORDER BY units_sold DESC, p.created_at DESC
      LIMIT $4`,
    [excludeId, excludeIds, categoryName, limit]
  )
  return rows.map((r) => ({ ...withSalePrice(r), type: 'product', category: r.category_name }))
}

async function fetchServices({ categoryName, excludeId, limit, excludeIds = [] }) {
  if (limit <= 0) return []
  const { rows } = await query(
    `SELECT ${SERVICE_COLUMNS}
       FROM services s
       LEFT JOIN categories c ON c.id = s.category_id
       ${SERVICE_SOLD_JOIN}
      WHERE s.is_active = TRUE AND s.id <> $1 AND NOT (s.id = ANY($2::uuid[]))
        AND ($3::text IS NULL OR c.name ILIKE $3)
      ORDER BY units_sold DESC, s.created_at DESC
      LIMIT $4`,
    [excludeId, excludeIds, categoryName, limit]
  )
  const branchMap = await branchesByService(rows.map((r) => r.id))
  return rows.map((r) => ({ ...withSalePrice(r), type: 'service', category: r.category_name, branches: branchMap.get(r.id) ?? [] }))
}

export async function getRelatedItems({ type, id, categoryName }) {
  const productExcludeId = type === 'product' ? id : '00000000-0000-0000-0000-000000000000'
  const serviceExcludeId = type === 'service' ? id : '00000000-0000-0000-0000-000000000000'

  let picked = []
  if (categoryName) {
    const [sameProducts, sameServices] = await Promise.all([
      fetchProducts({ categoryName, excludeId: productExcludeId, limit: TARGET }),
      fetchServices({ categoryName, excludeId: serviceExcludeId, limit: TARGET }),
    ])
    // Interleave so a popular service isn't crowded out by four products.
    const a = sameProducts.sort((x, y) => y.units_sold - x.units_sold)
    const b = sameServices.sort((x, y) => y.units_sold - x.units_sold)
    const merged = []
    while ((a.length || b.length) && merged.length < TARGET) {
      if (a.length) merged.push(a.shift())
      if (b.length && merged.length < TARGET) merged.push(b.shift())
    }
    picked = merged
  }

  if (picked.length < TARGET) {
    const stillNeeded = TARGET - picked.length
    const pickedProductIds = picked.filter((p) => p.type === 'product').map((p) => p.id)
    const pickedServiceIds = picked.filter((p) => p.type === 'service').map((p) => p.id)
    const [fillProducts, fillServices] = await Promise.all([
      fetchProducts({ categoryName: null, excludeId: productExcludeId, limit: TARGET, excludeIds: pickedProductIds }),
      fetchServices({ categoryName: null, excludeId: serviceExcludeId, limit: TARGET, excludeIds: pickedServiceIds }),
    ])
    const fillers = [...fillProducts, ...fillServices].sort((x, y) => y.units_sold - x.units_sold).slice(0, stillNeeded)
    picked = [...picked, ...fillers]
  }

  return picked
}
