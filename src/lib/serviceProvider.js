import { query } from '../db/pool.js'

// The company that actually delivers the bookable/purchasable services
// (a subsidiary of Shani'z). Stored as ONE row in site_settings under the
// key 'service_provider', edited from Admin -> Services.
//
//   name        e.g. "Miracles Hair and Skin Clinic"
//   logo_url    optional picture (empty = show the name as text instead)
//   wording_xx  the sentence shown next to the logo, per language.
//               "{name}" is swapped for the name, so an admin can write
//               "A service by {name}" or "Offered by our partner {name}".
//
// This file is the one place the backend reads it, so emails, SMS texts and
// invoice PDFs all agree with what the website shows.

export const DEFAULT_PROVIDER = {
  name: 'Miracles Hair and Skin Clinic',
  logo_url: '',
  wording_en: 'Provided by {name}',
  wording_si: '{name} විසින් සපයනු ලබන සේවාවකි',
  wording_ta: '{name} வழங்கும் சேவை',
}

const TTL_MS = 60_000
let cache = { value: null, at: 0 }

export function clearServiceProviderCache() {
  cache = { value: null, at: 0 }
}

// Never throws: if the database row is missing (migration not run yet) or
// the query fails, the defaults are used so an email/invoice still goes out.
export async function getServiceProvider() {
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value
  try {
    const { rows } = await query(`SELECT value FROM site_settings WHERE key = 'service_provider'`)
    const saved = rows[0]?.value && typeof rows[0].value === 'object' ? rows[0].value : {}
    const value = { ...DEFAULT_PROVIDER, ...saved }
    cache = { value, at: Date.now() }
    return value
  } catch (err) {
    console.error('[service-provider] could not load, using defaults:', err.message)
    return { ...DEFAULT_PROVIDER }
  }
}

// "Provided by Miracles Hair and Skin Clinic" (falls back to English when
// that language has no wording written yet).
export function providerWording(provider, lang = 'en') {
  const template = (provider[`wording_${lang}`] || provider.wording_en || DEFAULT_PROVIDER.wording_en).trim()
  return template.replace(/\{name\}/g, provider.name)
}

// Where an appointment happens, always under the provider's name:
// "Miracles Hair and Skin Clinic — Kandy". Skips the prefix if the branch
// name already contains the provider's name, so it never reads twice.
export function providerBranchLabel(provider, branchName) {
  if (!provider?.name) return branchName ?? ''
  if (!branchName) return provider.name
  return branchName.toLowerCase().includes(provider.name.toLowerCase()) ? branchName : `${provider.name} — ${branchName}`
}
