import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { regionsForApi } from '../lib/delivery.js'
import { sendContactMessageEmail } from '../lib/email.js'
import { translateToEnglish } from '../lib/ai.js'
import { logActivity, logBoth } from '../lib/log.js'
import { requireRole } from '../middleware/auth.js'
import { getServiceProvider, clearServiceProviderCache } from '../lib/serviceProvider.js'
import { contactLimiter, addressAutocompleteLimiter } from '../middleware/rateLimit.js'
import { autocompleteAddress } from '../lib/geocode.js'

const router = Router()

// Public: "Address line 1" suggestions while typing, at checkout and on
// the account page's saved-address form. Never a hard failure for the
// person typing — if both geocoding providers are down or the query is
// too short to be useful, this just returns an empty suggestion list
// and normal free-text typing keeps working exactly as before.
router.get('/address-autocomplete', addressAutocompleteLimiter, async (req, res) => {
  const parsed = z.string().trim().min(3).max(200).safeParse(req.query.q)
  if (!parsed.success) return res.json({ suggestions: [] })

  try {
    // Already just { line1 } strings, deduplicated — see geocode.js's
    // buildStreetLine for why this isn't the raw display_name (which
    // would repeat the City/Postal Code fields sitting right next to
    // this one on the form).
    const results = await autocompleteAddress(parsed.data)
    const suggestions = results.map((r) => r.line1).slice(0, 6)
    res.json({ suggestions })
  } catch (err) {
    console.error('[address-autocomplete] failed:', err.message)
    res.json({ suggestions: [] })
  }
})

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

// Public: homepage text content (Hero/About/Ritual sections), editable
// from Admin → Homepage Content. Returns just whatever's been saved —
// the frontend merges this with its own hardcoded defaults, so a field
// that's never been touched still shows sensible copy.
router.get('/homepage-content', async (req, res) => {
  const { rows } = await query(`SELECT value FROM site_settings WHERE key = 'homepage_content'`)
  res.json({ homepage_content: rows[0]?.value ?? {} })
})

// Public: the subsidiary that provides every service (name, logo, and the
// "Provided by ..." wording in each language). Shown on service thumbnails,
// service pages, the booking pop-up, basket and checkout.
router.get('/service-provider', async (req, res) => {
  res.json({ service_provider: await getServiceProvider() })
})

const providerSchema = z.object({
  name: z.string().trim().min(1, 'Please enter the company name.').max(120),
  // Empty = no logo (the name is shown as text instead). Only http(s) links.
  logo_url: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), 'The logo must be an uploaded image.'),
  wording_en: z.string().trim().min(1, 'Please enter the English wording.').max(160),
  wording_si: z.string().trim().max(160).optional().default(''),
  wording_ta: z.string().trim().max(160).optional().default(''),
})

// Admin-only. Plain text only (React and the email templates escape it).
router.put('/service-provider', requireRole('admin', 'superadmin'), async (req, res) => {
  const parsed = providerSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  await query(
    `INSERT INTO site_settings (key, value) VALUES ('service_provider', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(parsed.data)]
  )
  clearServiceProviderCache()
  await logBoth(req.user.id, 'service_provider.updated', 'service_provider', { name: parsed.data.name })
  res.json({ service_provider: await getServiceProvider() })
})

const contactSchema = z.object({
  name: z.string().min(1, 'Please enter your name.').max(200),
  email: z.string().email('Please enter a valid email.'),
  message: z.string().min(1, 'Please enter a message.').max(4000),
  // Which language the visitor had the site set to when they wrote
  // this — sent by the frontend's language switcher state, not
  // detected here. Only 'si'/'ta' trigger a translation attempt below;
  // 'en' (or missing, for older/cached frontend builds) skips it
  // entirely rather than needlessly round-tripping English through
  // the translator.
  language: z.enum(['en', 'si', 'ta']).optional(),
})

// Public: the homepage "Visit us" contact form (project-spec.md —
// previously listed under "What's stubbed" as a front-end-only demo).
// No account/login needed to send a message, so it's rate-limited here
// specifically (contactLimiter) on top of the general apiLimiter that
// already applies to all of /api.
router.post('/contact', contactLimiter, async (req, res) => {
  const parsed = contactSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message })

  const { rows } = await query(`SELECT value FROM site_settings WHERE key = 'business_info'`)
  const toEmail = rows[0]?.value?.email || process.env.EMAIL_FROM

  // Best-effort: translateToEnglish() never throws and returns null on
  // any failure (missing API key, quota, network hiccup) — the
  // business owner just gets the message without a translation
  // underneath in that case, never a broken/blocked submission.
  const englishTranslation =
    parsed.data.language && parsed.data.language !== 'en' ? await translateToEnglish(parsed.data.message) : null

  await sendContactMessageEmail(parsed.data, toEmail, englishTranslation)
  await logActivity(null, `contact.message_received (${parsed.data.email})`)

  res.status(201).json({ ok: true })
})

// Public: a lightweight first-party page-view counter for the admin
// dashboard (see db/schema.sql page_views table). Fired from the
// frontend's router on every navigation, alongside (not instead of)
// Google Analytics — this exists so the admin dashboard has real traffic
// numbers without needing a separate Google OAuth/Reporting API
// integration just to read GA's own data back out.
//
// Deliberately forgiving: a malformed body or a failed insert never
// surfaces as an error to the visitor — a broken page-view beacon should
// never be something a real customer notices or that blocks navigation.
const pageviewSchema = z.object({ path: z.string().trim().min(1).max(500) })

router.post('/pageview', async (req, res) => {
  const parsed = pageviewSchema.safeParse(req.body)
  if (parsed.success) {
    try {
      await query(`INSERT INTO page_views (path) VALUES ($1)`, [parsed.data.path])
    } catch (err) {
      console.error('[pageview] insert failed:', err.message)
    }
  }
  res.status(204).end()
})

export default router
