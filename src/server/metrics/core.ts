import type { Queryable } from "../db";
import type { Window } from "./range";

/**
 * The basic measurements, each defined once and used by every page (see docs/METRICS.md).
 * All take an environment and a [from, to) window in UTC.
 */

/** Sessions longer than this are not expected (Roblox servers recycle); bounds index scans. */
const MAX_SESSION_DAYS = 7;

export async function ccuNow(db: Queryable, env: string, timeoutSec: number, now = new Date()) {
  const { rows } = await db.query<{ ccu: string; servers: string; sessions: string }>(
    `SELECT
       (SELECT count(DISTINCT player_key) FROM sessions WHERE env = $1 AND ended_at IS NULL AND last_seen_at >= $2::timestamptz - make_interval(secs => $3)) AS ccu,
       (SELECT count(*) FROM sessions WHERE env = $1 AND ended_at IS NULL AND last_seen_at >= $2::timestamptz - make_interval(secs => $3)) AS sessions,
       (SELECT count(*) FROM servers WHERE env = $1 AND ended_at IS NULL AND last_heartbeat_at >= $2::timestamptz - make_interval(secs => $3)) AS servers`,
    [env, now, timeoutSec],
  );
  return { ccu: Number(rows[0].ccu), servers: Number(rows[0].servers), sessions: Number(rows[0].sessions) };
}

/** Visits = experience visits started in the window (a teleport between our servers continues a visit). */
export async function visits(db: Queryable, env: string, w: Window) {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM sessions WHERE env = $1 AND started_at >= $2 AND started_at < $3 AND visit_id = session_id`,
    [env, w.from, w.to],
  );
  return Number(rows[0].n);
}

export async function sessionsStarted(db: Queryable, env: string, w: Window) {
  const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM sessions WHERE env = $1 AND started_at >= $2 AND started_at < $3`, [env, w.from, w.to]);
  return Number(rows[0].n);
}

export async function lifetimeVisits(db: Queryable, env: string) {
  const { rows } = await db.query<{ n: string; since: Date | null }>(
    `SELECT count(*) AS n, min(started_at) AS since FROM sessions WHERE env = $1 AND visit_id = session_id`,
    [env],
  );
  return { visits: Number(rows[0].n), since: rows[0].since };
}

/** Distinct players with any session overlapping the window. */
export async function uniquePlayers(db: Queryable, env: string, w: Window) {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(DISTINCT player_key) AS n FROM sessions
     WHERE env = $1 AND started_at < $3 AND COALESCE(ended_at, last_seen_at) >= $2
       AND started_at >= $2::timestamptz - make_interval(days => $4)`,
    [env, w.from, w.to, MAX_SESSION_DAYS],
  );
  return Number(rows[0].n);
}

/** Distinct active players over whole reporting days, from player_days (exact, cheap for long ranges). */
export async function uniquePlayersDays(db: Queryable, env: string, fromDay: string, toDay: string) {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(DISTINCT player_key) AS n FROM player_days WHERE env = $1 AND day BETWEEN $2::date AND $3::date`,
    [env, fromDay, toDay],
  );
  return Number(rows[0].n);
}

/** Players whose first observed session started in the window. */
export async function newPlayers(db: Queryable, env: string, w: Window) {
  const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM players WHERE env = $1 AND first_seen_at >= $2 AND first_seen_at < $3`, [env, w.from, w.to]);
  return Number(rows[0].n);
}

/** Playtime (seconds) inside the window, summed over all sessions (clipped to the window). */
export async function playtimeSeconds(db: Queryable, env: string, w: Window) {
  const { rows } = await db.query<{ s: string | null }>(
    `SELECT sum(GREATEST(0, EXTRACT(EPOCH FROM LEAST(COALESCE(ended_at, last_seen_at), $3::timestamptz) - GREATEST(started_at, $2::timestamptz)))) AS s
     FROM sessions WHERE env = $1 AND started_at < $3 AND COALESCE(ended_at, last_seen_at) >= $2
       AND started_at >= $2::timestamptz - make_interval(days => $4)`,
    [env, w.from, w.to, MAX_SESSION_DAYS],
  );
  return Math.round(Number(rows[0].s ?? 0));
}

/**
 * Visit length statistics over closed visits that started in the window.
 * A visit's length is first join to last leave across its linked sessions.
 */
export async function visitLengths(db: Queryable, env: string, w: Window) {
  const { rows } = await db.query<{ n: string; avg: number | null; median: number | null; p90: number | null }>(
    `WITH v AS (
       SELECT visit_id, min(started_at) AS vstart, EXTRACT(EPOCH FROM max(COALESCE(ended_at, last_seen_at)) - min(started_at)) AS dur
       FROM sessions WHERE env = $1 AND started_at >= $2::timestamptz - interval '1 day' AND started_at < $3::timestamptz + interval '1 day'
       GROUP BY visit_id HAVING bool_and(ended_at IS NOT NULL))
     SELECT count(*) AS n, avg(dur) AS avg, percentile_cont(0.5) WITHIN GROUP (ORDER BY dur) AS median,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY dur) AS p90
     FROM v WHERE vstart >= $2 AND vstart < $3`,
    [env, w.from, w.to],
  );
  const r = rows[0];
  return { closedVisits: Number(r.n), avgSec: r.avg === null ? null : Number(r.avg), medianSec: r.median === null ? null : Number(r.median), p90Sec: r.p90 === null ? null : Number(r.p90) };
}

export async function peakCcu(db: Queryable, env: string, w: Window) {
  const { rows } = await db.query<{ peak: number | null; at: Date | null }>(
    `SELECT peak_ccu AS peak, minute AS at FROM ccu_minutes WHERE env = $1 AND minute >= date_trunc('minute', $2::timestamptz) AND minute < $3
     ORDER BY peak_ccu DESC, minute ASC LIMIT 1`,
    [env, w.from, w.to],
  );
  return { peak: rows[0]?.peak ?? null, at: rows[0]?.at ?? null };
}

/** Confirmed, not-refunded purchases in the window. */
export async function revenue(db: Queryable, env: string, w: Window) {
  const { rows } = await db.query<{ gross: string | null; est: string | null; verified: string | null; n: string; payers: string; pending: string; pending_robux: string | null }>(
    `SELECT
       sum(robux_gross) FILTER (WHERE status = 'confirmed' AND refunded_at IS NULL) AS gross,
       sum(estimated_creator_robux) FILTER (WHERE status = 'confirmed' AND refunded_at IS NULL) AS est,
       sum(verified_creator_robux) FILTER (WHERE status = 'confirmed' AND refunded_at IS NULL) AS verified,
       count(*) FILTER (WHERE status = 'confirmed' AND refunded_at IS NULL) AS n,
       count(DISTINCT player_key) FILTER (WHERE status = 'confirmed' AND refunded_at IS NULL) AS payers,
       count(*) FILTER (WHERE status = 'pending_verification') AS pending,
       sum(robux_gross) FILTER (WHERE status = 'pending_verification') AS pending_robux
     FROM purchases WHERE env = $1 AND purchased_at >= $2 AND purchased_at < $3`,
    [env, w.from, w.to],
  );
  const r = rows[0];
  return {
    grossRobux: Number(r.gross ?? 0),
    estimatedCreatorRobux: Number(r.est ?? 0),
    verifiedCreatorRobux: r.verified === null ? null : Number(r.verified),
    purchases: Number(r.n),
    payingUsers: Number(r.payers),
    pendingPurchases: Number(r.pending),
    pendingRobux: Number(r.pending_robux ?? 0),
  };
}

export async function lifetimeRevenue(db: Queryable, env: string) {
  const { rows } = await db.query<{ gross: string | null; est: string | null; n: string; since: Date | null }>(
    `SELECT sum(robux_gross) AS gross, sum(estimated_creator_robux) AS est, count(*) AS n, min(purchased_at) AS since
     FROM purchases WHERE env = $1 AND status = 'confirmed' AND refunded_at IS NULL`,
    [env],
  );
  return { grossRobux: Number(rows[0].gross ?? 0), estimatedCreatorRobux: Number(rows[0].est ?? 0), purchases: Number(rows[0].n), since: rows[0].since };
}

/** helper: % change, null when there is no meaningful base */
export function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null) return null;
  if (prev === 0) return cur === 0 ? 0 : null;
  return ((cur - prev) / prev) * 100;
}
