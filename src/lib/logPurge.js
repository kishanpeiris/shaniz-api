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
      // Privacy: an order's IP address is only needed for short-term fraud
      // checks (see lib/fraud.js), so it is wiped after 90 days.
      const ips = await query(
        `UPDATE orders SET customer_ip = NULL WHERE customer_ip IS NOT NULL AND created_at < now() - interval '90 days'`
      )
      console.log(`[log-purge] cleared ${ips.rowCount} old order IP address(es)`)
      console.log(`[log-purge] removed ${audit.rowCount} audit rows, ${activity.rowCount} activity rows`)
    } catch (err) {
      console.error('[log-purge] failed:', err)
    }
  })
}
