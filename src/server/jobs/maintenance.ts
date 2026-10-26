import type { Queryable } from "../db";
import { env } from "../env";
import { getSettings } from "../settings";

/**
 * Public experience stats Roblox reports (games.roblox.com, no key needed). Stored as "Roblox-reported"
 * and always shown next to, never mixed into, our own tracked numbers.
 */
export async function fetchRobloxReported(db: Queryable, now = new Date()): Promise<string> {
  const universeId = env().ROBLOX_UNIVERSE_ID;
  if (!universeId) return "skipped (ROBLOX_UNIVERSE_ID not set)";
  const res = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`games API responded ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ visits?: number; playing?: number; favoritedCount?: number }> };
  const g = body.data?.[0];
  if (!g) throw new Error("games API returned no data for this universe id");
  const metrics: Array<[string, number | undefined]> = [["visits", g.visits], ["playing", g.playing], ["favorites", g.favoritedCount]];
  for (const [metric, value] of metrics) {
    if (typeof value !== "number") continue;
    await db.query(`INSERT INTO roblox_reported (metric, value, as_of, source) VALUES ($1,$2,$3,'games_api')`, [metric, value, now]);
  }
  return `visits=${g.visits} playing=${g.playing} favorites=${g.favoritedCount}`;
}

/** Retention policy: raw events and heartbeats are only needed for audit and debugging. */
export async function prune(db: Queryable, now = new Date()) {
  const s = await getSettings(db, true);
  const out: Record<string, number> = {};
  const del = async (name: string, sql: string, params: unknown[]) => {
    out[name] = (await db.query(sql, params)).rowCount ?? 0;
  };
  await del("raw_events", `DELETE FROM raw_events WHERE received_at < $1::timestamptz - make_interval(days => $2)`, [now, s.raw_event_retention_days]);
  await del("server_heartbeats", `DELETE FROM server_heartbeats WHERE at < $1::timestamptz - make_interval(days => $2)`, [now, s.heartbeat_retention_days]);
  // request ids only need to outlive the 15-minute replay window (kept 2 days for the ingestion chart)
  await del("ingest_requests", `DELETE FROM ingest_requests WHERE received_at < $1::timestamptz - interval '2 days'`, [now]);
  await del("user_sessions", `DELETE FROM user_sessions WHERE expires_at < $1`, [now]);
  // games API samples: every 10 minutes for 30 days, then one per metric per hour
  await del(
    "roblox_reported",
    `DELETE FROM roblox_reported WHERE source = 'games_api' AND as_of < $1::timestamptz - interval '30 days'
       AND id NOT IN (SELECT DISTINCT ON (metric, date_trunc('hour', as_of)) id FROM roblox_reported
                      WHERE source = 'games_api' ORDER BY metric, date_trunc('hour', as_of), as_of)`,
    [now],
  );
  await del("audit_log", `DELETE FROM audit_log WHERE at < $1::timestamptz - interval '400 days'`, [now]);
  return out;
}
