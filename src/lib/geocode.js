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
//
// addressdetails=1 asks both providers for the address broken into
// parts (house_number, road, city, state, postcode, country...) rather
// than one long display_name string. That matters here specifically:
// "Address line 1" sits right next to its own City and Postal Code
// fields, so a suggestion like "Pathiba Road, Narahenpita, Colombo,
// Colombo District, Western Province, 00500, Sri Lanka" is mostly
// duplicating what those other two fields already show. buildStreetLine
// below keeps only the house-number/road part for line 1 itself.
async function autocompleteWithLocationIQ(q, apiKey) {
  const url = `https://api.locationiq.com/v1/autocomplete?key=${apiKey}&q=${encodeURIComponent(q)}&countrycodes=lk&limit=6&addressdetails=1&format=json`
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
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=lk&addressdetails=1&q=${encodeURIComponent(q)}`
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

// Keeps only the house-number/street part of a result — never the
// city/district/province/postcode/country, which the City and Postal
// Code fields already own. Falls back to the most specific *named
// place* available (neighbourhood/suburb/village) when there's no
// tagged road, which is common for smaller lanes in OpenStreetMap's
// Sri Lanka coverage — an empty line1 would be a useless suggestion,
// but "Narahenpita" alone is still a real improvement over nothing.
function buildStreetLine(address = {}) {
  const houseAndRoad = [address.house_number, address.road].filter(Boolean).join(' ')
  if (houseAndRoad) return houseAndRoad
  return address.neighbourhood || address.suburb || address.hamlet || address.village || ''
}

// Returns an array of { line1, lat, lon } (possibly empty) — line1 is
// the trimmed street-only text described above, already de-duplicated
// against city/postcode/country. Throws only if BOTH providers fail
// outright — callers should treat that as "no suggestions this time"
// rather than a hard error, since this only ever assists typing and
// must never block checkout.
export async function autocompleteAddress(q) {
  const apiKey = process.env.GEOCODING_API_KEY
  let results
  try {
    results = apiKey ? await autocompleteWithLocationIQ(q, apiKey) : await autocompleteWithNominatim(q)
  } catch (primaryErr) {
    if (apiKey) {
      try {
        results = await autocompleteWithNominatim(q)
      } catch (fallbackErr) {
        console.error('[address-autocomplete] both providers failed:', primaryErr.message, fallbackErr.message)
        throw fallbackErr
      }
    } else {
      throw primaryErr
    }
  }

  const seen = new Set()
  const suggestions = []
  for (const r of results || []) {
    const line1 = buildStreetLine(r.address)
    if (!line1 || seen.has(line1)) continue // skip empties and exact repeats (multiple POIs on the same road)
    seen.add(line1)
    suggestions.push({ line1, lat: r.lat, lon: r.lon })
  }
  return suggestions
}
