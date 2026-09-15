// Sri Lanka delivery pricing — checkout requirement: "delivery options
// (pickup, delivery — changing based on location in Sri Lanka, main
// Colombo region vs suburbs vs outer suburbs vs out of Colombo)."
//
// Regions now live in the `delivery_regions` table (see db/schema.sql)
// and are editable from Admin → Delivery, instead of being hardcoded
// here. To keep checkout validation simple and synchronous (the zod
// schema in orders.routes.js calls isValidRegion()/deliveryFee() inside
// a plain, non-async .refine()), the current rows are kept in a small
// in-memory cache that's loaded once at server startup and refreshed
// immediately after any admin edit — see loadRegions() below and its
// callers in server.js and admin.routes.js.
import { query } from '../db/pool.js'

// Used only if the database has no rows yet (e.g. schema.sql hasn't been
// migrated in this environment) — checkout still works instead of every
// delivery order failing validation.
const FALLBACK_REGIONS = [
  { id: 'colombo_main', label: 'Colombo (Main City — Colombo 1–15)', fee_lkr: 350, example: 'Colombo Fort, Bambalapitiya, Wellawatte, Borella' },
  { id: 'colombo_suburbs', label: 'Colombo Suburbs', fee_lkr: 450, example: 'Dehiwala, Nugegoda, Kotte, Maharagama, Rajagiriya' },
  { id: 'outer_suburbs', label: 'Outer Suburbs', fee_lkr: 550, example: 'Kaduwela, Homagama, Ja-Ela, Wattala, Kesbewa' },
  { id: 'outside_colombo', label: 'Outside Colombo (Island-wide)', fee_lkr: 750, example: 'Kandy, Galle, Jaffna, Negombo, and everywhere else' },
]

let cache = FALLBACK_REGIONS

// Re-reads every active region from the database into the in-memory
// cache. Call this once at server startup (server.js) and again after
// any create/update/delete from the admin API, so every request always
// sees the latest rates without hitting the database on every checkout.
export async function loadRegions() {
  try {
    const { rows } = await query(
      `SELECT id, label, fee_lkr, example FROM delivery_regions
       WHERE is_active = TRUE ORDER BY sort_order ASC, label ASC`
    )
    cache = rows.length > 0 ? rows.map((r) => ({ ...r, fee_lkr: Number(r.fee_lkr) })) : FALLBACK_REGIONS
  } catch (err) {
    // Table might not exist yet on a brand-new environment before the
    // first migration runs — fall back rather than crashing startup.
    console.warn('[delivery] could not load delivery_regions, using fallback rates:', err.message)
    cache = FALLBACK_REGIONS
  }
  return cache
}

export function deliveryFee(method, region) {
  if (method !== 'delivery') return 0
  return cache.find((r) => r.id === region)?.fee_lkr ?? 0
}

export function isValidRegion(region) {
  return cache.some((r) => r.id === region)
}

// Shape returned to the frontend so region labels/fees only ever live
// here, never duplicated in the React app.
export function regionsForApi() {
  return cache.map((r) => ({ id: r.id, label: r.label, fee_lkr: r.fee_lkr, example: r.example }))
}
