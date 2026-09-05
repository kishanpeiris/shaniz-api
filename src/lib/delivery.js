// Sri Lanka delivery pricing — checkout requirement: "delivery options
// (pickup, delivery — changing based on location in Sri Lanka, main
// Colombo region vs suburbs vs outer suburbs vs out of Colombo)."
//
// These are placeholder fees — adjust REGIONS below to your actual
// courier rates whenever you have them; nothing else needs to change,
// every price calculation reads from this one place.

export const REGIONS = {
  colombo_main: {
    label: 'Colombo (Main City — Colombo 1–15)',
    fee_lkr: 350,
    example: 'Colombo Fort, Bambalapitiya, Wellawatte, Borella',
  },
  colombo_suburbs: {
    label: 'Colombo Suburbs',
    fee_lkr: 450,
    example: 'Dehiwala, Nugegoda, Kotte, Maharagama, Rajagiriya',
  },
  outer_suburbs: {
    label: 'Outer Suburbs',
    fee_lkr: 550,
    example: 'Kaduwela, Homagama, Ja-Ela, Wattala, Kesbewa',
  },
  outside_colombo: {
    label: 'Outside Colombo (Island-wide)',
    fee_lkr: 750,
    example: 'Kandy, Galle, Jaffna, Negombo, and everywhere else',
  },
}

export function deliveryFee(method, region) {
  if (method === 'pickup') return 0
  if (method !== 'delivery') return 0
  return REGIONS[region]?.fee_lkr ?? 0
}

export function isValidRegion(region) {
  return Object.prototype.hasOwnProperty.call(REGIONS, region)
}

// Shape returned to the frontend so region labels/fees only ever live
// here, never duplicated in the React app.
export function regionsForApi() {
  return Object.entries(REGIONS).map(([id, r]) => ({
    id,
    label: r.label,
    fee_lkr: r.fee_lkr,
    example: r.example,
  }))
}
