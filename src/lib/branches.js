import { query } from '../db/pool.js'

// Which branches offer each service (from the service_branches table).
// Returns Map(serviceId -> [{ id, name, address, latitude, longitude, phone }]).
// Shared by services.routes.js and related.js so both agree on the shape.
export async function branchesByService(serviceIds) {
  const { rows } = await query(
    `SELECT sb.service_id, b.id, b.name, b.address, b.latitude, b.longitude, b.phone
     FROM service_branches sb JOIN branches b ON b.id = sb.branch_id
     ${serviceIds ? 'WHERE sb.service_id = ANY($1::uuid[])' : ''}
     ORDER BY b.name`,
    serviceIds ? [serviceIds] : []
  )
  const map = new Map()
  for (const r of rows) {
    const { service_id, ...branch } = r
    if (!map.has(service_id)) map.set(service_id, [])
    map.get(service_id).push(branch)
  }
  return map
}
