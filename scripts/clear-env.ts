/**
 * Deletes all data of a NON-production environment (simulation or studio), e.g. before a fresh
 * simulator run.  npm run db:clear-env -- --env simulation
 * Production can never be cleared with this script.
 */
import { parseArgs } from "node:util";
import { pool } from "../src/server/db";

const TABLES = ["raw_events", "server_heartbeats", "gameplay_events", "runs", "purchases", "sessions", "player_days", "players", "servers",
  "ccu_minutes", "hourly_stats", "daily_stats", "retention_cohorts", "server_counters", "alert_events"];

async function main() {
  const { values } = parseArgs({ options: { env: { type: "string" } } });
  if (values.env !== "simulation" && values.env !== "studio") throw new Error("--env must be simulation or studio (production is never cleared)");
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    for (const t of TABLES) {
      const r = await c.query(`DELETE FROM ${t} WHERE env = $1`, [values.env]);
      if (r.rowCount) console.log(`${t}: ${r.rowCount}`);
    }
    await c.query(`INSERT INTO audit_log (action, target) VALUES ('env_cleared_cli', $1)`, [values.env]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  await pool().end();
}
main().catch(async (e) => {
  console.error(e.message);
  await pool().end().catch(() => undefined);
  process.exit(1);
});
