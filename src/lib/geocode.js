// Address-line autocomplete for checkout/account forms — "start typing a
// street address, get real suggestions back." Same two-provider approach
// as the admin branch-location lookup in routes/branches.routes.js
// (LocationIQ primary, Nominatim fallback), kept as its own small module
// so this public-facing endpoint doesn't depend on that admin-only file.
//
// countrycodes=lk on both providers keeps results relevant (the site
// only ships within Sri Lanka per checkout's existing "Sri Lanka only"
// note) and meaningfully improves match quality by not wasting the
// query on addresses elsewhere in the world.
async function autocompleteWithLocationIQ(q, apiKey) {
  const url = `https://api.locationiq.com/v1/autocomplete?key=${apiKey}&q=${encodeURIComponent(q)}&countrycodes=lk&limit=6&format=json`
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    // LocationIQ returns 404 with a body for "no results", which isn't
    // really an error — treat it as an empty list rather than throwing.
    if (response.status === 404) return []
    console.error('[address-autocomplete] LocationIQ error', response.status, body)
    throw new Error(`LocationIQ returned ${response.status}`)
  }
  return body
}

async function autocompleteWithNominatim(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=lk&q=${encodeURIComponent(q)}`
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ShanizStorefront/1.0 (checkout address autocomplete)',
      Accept: 'application/json',
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    console.error('[address-autocomplete] Nominatim error', response.status, body)
    throw new Error(`Nominatim returned ${response.status}`)
  }
  return body
}

// Returns an array of { display_name, lat, lon } (possibly empty).
// Throws only if BOTH providers fail outright — callers should treat
// that as "no suggestions this time" rather than a hard error, since
// this only ever assists typing and must never block checkout.
export async function autocompleteAddress(q) {
  const apiKey = process.env.GEOCODING_API_KEY
  try {
    return apiKey ? await autocompleteWithLocationIQ(q, apiKey) : await autocompleteWithNominatim(q)
  } catch (primaryErr) {
    if (apiKey) {
      try {
        return await autocompleteWithNominatim(q)
      } catch (fallbackErr) {
        console.error('[address-autocomplete] both providers failed:', primaryErr.message, fallbackErr.message)
        throw fallbackErr
      }
    }
    throw primaryErr
  }
}
