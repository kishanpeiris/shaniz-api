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

  // Maintenance mode is schedule-driven, not a bare on/off switch (an
  // admin sets starts_at, and optionally ends_at, from the Maintenance
  // page) — compute whether it's ACTUALLY in effect right now, server
  // side, so client clock differences can't matter. Older/legacy rows
  // (a plain `true`/`false` from before this was schedule-based) are
  // handled too: a bare `true` is treated as "on with no schedule",
  // active immediately.
  const raw = settings.rows[0]?.value
  const schedule =
    typeof raw === 'boolean' ? { enabled: raw, starts_at: null, ends_at: null, reason: null } : raw || { enabled: false }

  const now = Date.now()
  const startsAt = schedule.starts_at ? new Date(schedule.starts_at).getTime() : null
  const endsAt = schedule.ends_at ? new Date(schedule.ends_at).getTime() : null
  const maintenanceActive = Boolean(schedule.enabled) && (startsAt === null || now >= startsAt) && (endsAt === null || now <= endsAt)

  res.json({
    maintenance_mode: maintenanceActive,
    maintenance_schedule: schedule,
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
