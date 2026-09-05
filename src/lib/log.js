import { query } from '../db/pool.js'

// Every admin action, login, and payment event should call one or both
// of these (spec Section 7, Monitoring: "Log all payment events to the
// audit log for fraud review").

export async function logAudit(actorId, action, target = null, metadata = null) {
  await query(
    `INSERT INTO audit_log (actor_id, action, target, metadata) VALUES ($1, $2, $3, $4)`,
    [actorId, action, target, metadata ? JSON.stringify(metadata) : null]
  )
}

export async function logActivity(actorId, action) {
  await query(`INSERT INTO activity_log (actor_id, action) VALUES ($1, $2)`, [actorId, action])
}

export async function logBoth(actorId, action, target = null, metadata = null) {
  await Promise.all([logAudit(actorId, action, target, metadata), logActivity(actorId, action)])
}
