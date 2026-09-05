import cron from 'node-cron'
import { query } from '../db/pool.js'

// If your Postgres host supports pg_cron (Neon/Supabase do), prefer the
// SQL version commented at the bottom of db/schema.sql instead — it runs
// even if this Node process is asleep or redeployed. This is the
// fallback for hosts without pg_cron (e.g. a bare Render/Railway box).

export function startLogPurgeJob() {
  // Runs daily at 03:00 server time.
  cron.schedule('0 3 * * *', async () => {
    try {
      const audit = await query(`DELETE FROM audit_log WHERE created_at < now() - interval '30 days'`)
      const activity = await query(`DELETE FROM activity_log WHERE created_at < now() - interval '15 days'`)
      console.log(`[log-purge] removed ${audit.rowCount} audit rows, ${activity.rowCount} activity rows`)
    } catch (err) {
      console.error('[log-purge] failed:', err)
    }
  })
}
