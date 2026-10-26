import type { Queryable } from "../db";

/**
 * Reconciliation: a game server that stops sending heartbeats (crash, network loss) is closed at its
 * last heartbeat, and every session still open on it, or silent for longer than the timeout, is closed
 * at its own last-seen time. A later heartbeat reopens either (see ingest/process.ts).
 */
export async function reap(db: Queryable, timeoutSec: number, now = new Date()): Promise<{ servers: number; sessions: number; runs: number }> {
  const servers = await db.query(
    `UPDATE servers SET ended_at = last_heartbeat_at, end_reason = 'lost', player_count = 0
     WHERE ended_at IS NULL AND last_heartbeat_at < $1::timestamptz - make_interval(secs => $2)`,
    [now, timeoutSec],
  );
  const sessions = await db.query(
    `UPDATE sessions SET ended_at = last_seen_at, end_reason = 'timeout'
     WHERE ended_at IS NULL AND last_seen_at < $1::timestamptz - make_interval(secs => $2)`,
    [now, timeoutSec],
  );
  // a run whose player has had no open session for 10 minutes was abandoned (left mid-shift, crash, ...)
  const runs = await db.query(
    `UPDATE runs r SET outcome = 'abandoned', ended_at = GREATEST(r.started_at, sub.last_end)
     FROM (
       SELECT r2.env, r2.run_id, r2.player_key, max(COALESCE(s.ended_at, s.last_seen_at)) AS last_end,
              bool_or(s.ended_at IS NULL) AS any_open
       FROM runs r2 JOIN sessions s ON s.env = r2.env AND s.player_key = r2.player_key AND COALESCE(s.ended_at, s.last_seen_at) >= r2.started_at
       WHERE r2.ended_at IS NULL
       GROUP BY r2.env, r2.run_id, r2.player_key
     ) sub
     WHERE r.env = sub.env AND r.run_id = sub.run_id AND r.player_key = sub.player_key
       AND r.ended_at IS NULL AND NOT sub.any_open AND sub.last_end < $1::timestamptz - interval '10 minutes'`,
    [now],
  );
  return { servers: servers.rowCount ?? 0, sessions: sessions.rowCount ?? 0, runs: runs.rowCount ?? 0 };
}

/**
 * CCU sample: distinct players with an open session seen within the timeout. Stored per minute
 * (peak and last value), so peak CCU is exact to the 15 s sampling interval even when nobody has
 * the dashboard open.
 */
export async function sampleCcu(db: Queryable, timeoutSec: number, now = new Date()): Promise<Array<{ env: string; ccu: number; servers: number }>> {
  const { rows } = await db.query<{ env: string; ccu: string; servers: string }>(
    `WITH envs AS (SELECT unnest(ARRAY['production','studio','simulation']) AS env),
     live AS (
       SELECT env, count(DISTINCT player_key) AS ccu FROM sessions
       WHERE ended_at IS NULL AND last_seen_at >= $1::timestamptz - make_interval(secs => $2)
       GROUP BY env),
     srv AS (
       SELECT env, count(*) AS servers FROM servers
       WHERE ended_at IS NULL AND last_heartbeat_at >= $1::timestamptz - make_interval(secs => $2)
       GROUP BY env)
     SELECT e.env, COALESCE(l.ccu,0) AS ccu, COALESCE(s.servers,0) AS servers
     FROM envs e LEFT JOIN live l USING (env) LEFT JOIN srv s USING (env)`,
    [now, timeoutSec],
  );
  const out = rows.map((r) => ({ env: r.env, ccu: Number(r.ccu), servers: Number(r.servers) }));
  for (const r of out) {
    // record a minute for an environment only once it has ever had data, to keep empty envs clean
    if (r.ccu === 0 && r.servers === 0) {
      const any = await db.query(`SELECT 1 FROM servers WHERE env = $1 LIMIT 1`, [r.env]);
      if (any.rowCount === 0) continue;
    }
    await db.query(
      `INSERT INTO ccu_minutes (env, minute, peak_ccu, last_ccu, servers) VALUES ($1, date_trunc('minute', $2::timestamptz), $3, $3, $4)
       ON CONFLICT (env, minute) DO UPDATE SET peak_ccu = GREATEST(ccu_minutes.peak_ccu, EXCLUDED.peak_ccu),
         last_ccu = EXCLUDED.last_ccu, servers = GREATEST(ccu_minutes.servers, EXCLUDED.servers), samples = ccu_minutes.samples + 1`,
      [r.env, now, r.ccu, r.servers],
    );
  }
  return out;
}

/**
 * Teleport visits whose source session arrived after them (the lobby server's batch was committed
 * later, or it was in backoff) start as their own visit. This links them to the visit they continue,
 * using the same rule as ingest (same player, previous session ended or still open within 3 minutes).
 * Returns the earliest affected start, so rollups can recompute from there.
 */
export async function relinkTeleports(db: Queryable, now = new Date()): Promise<Date | null> {
  let earliest: Date | null = null;
  for (let pass = 0; pass < 3; pass++) {
    const { rows } = await db.query<{ started_at: Date }>(
      `WITH cand AS (
         SELECT s.session_id, s.env, s.started_at,
           (SELECT p.visit_id FROM sessions p
             WHERE p.env = s.env AND p.player_key = s.player_key AND p.session_id <> s.session_id
               AND p.started_at < s.started_at
               AND COALESCE(p.ended_at, p.last_seen_at) >= s.started_at - interval '180 seconds'
             ORDER BY p.started_at DESC LIMIT 1) AS prev_visit
         FROM sessions s
         WHERE s.teleport_in AND s.visit_id = s.session_id AND s.started_at >= $1::timestamptz - interval '2 days')
       UPDATE sessions t SET visit_id = c.prev_visit
       FROM cand c
       WHERE (t.session_id = c.session_id OR t.visit_id = c.session_id) AND c.prev_visit IS NOT NULL AND c.prev_visit <> c.session_id
       RETURNING c.started_at`,
      [now],
    );
    if (rows.length === 0) break;
    for (const r of rows) if (!earliest || r.started_at < earliest) earliest = r.started_at;
  }
  return earliest;
}
