import { Router } from 'express'
import { query } from '../db/pool.js'
import { regionsForApi } from '../lib/delivery.js'

const router = Router()

// Public: the front-end polls this to show the maintenance placeholder
// page or the "upcoming outage" banner — no manual banner editing needed
// (spec Section 10). Also carries the editable business info (phone,
// email, address, social links) so the Visit/Footer components don't
// need hardcoded values.
router.get('/status', async (req, res) => {
  const [settings, outages, businessInfo] = await Promise.all([
    query(`SELECT value FROM site_settings WHERE key = 'maintenance_mode'`),
    query(
      `SELECT id, starts_at, ends_at, reason, status FROM outage_windows
       WHERE status != 'completed'
         AND starts_at <= now() + interval '48 hours'
         AND ends_at >= now()
       ORDER BY starts_at LIMIT 1`
    ),
    query(`SELECT value FROM site_settings WHERE key = 'business_info'`),
  ])

  res.json({
    maintenance_mode: settings.rows[0]?.value === true,
    upcoming_outage: outages.rows[0] ?? null,
    business_info: businessInfo.rows[0]?.value ?? null,
  })
})

// Public: delivery methods + Sri Lanka regional fees for checkout. Kept
// server-side (src/lib/delivery.js) so there's exactly one place to
// update pricing, and so the client can't tamper with the fee it sends.
router.get('/delivery-options', (req, res) => {
  res.json({ regions: regionsForApi() })
})

export default router
