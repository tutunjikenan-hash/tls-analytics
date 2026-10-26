import type { Queryable } from "../db";
import { addDays } from "../jobs/rollups";
import type { ResolvedRange } from "./range";

/**
 * Time series for charts, read from the rollup tables (refreshed every 30-60 s by the job runner).
 * Buckets before tracking began are returned as null (no data), never as 0.
 */

export interface SeriesPoint {
  t: string; // ISO bucket start (UTC) for hours/minutes, YYYY-MM-DD for days
  visits: number | null;
  sessions: number | null;
  players: number | null;
  newPlayers: number | null;
  playtimeSec: number | null;
  revenueRobux: number | null;
  purchases: number | null;
  peakCcu: number | null;
}

/** When this environment first produced data (earliest server seen). */
export async function envTrackingStart(db: Queryable, env: string): Promise<Date | null> {
  const { rows } = await db.query<{ t: Date | null }>(`SELECT min(started_at) AS t FROM servers WHERE env = $1`, [env]);
  return rows[0].t;
}

const NULL_POINT = (t: string): SeriesPoint => ({ t, visits: null, sessions: null, players: null, newPlayers: null, playtimeSec: null, revenueRobux: null, purchases: null, peakCcu: null });
const ZERO_POINT = (t: string): SeriesPoint => ({ t, visits: 0, sessions: 0, players: 0, newPlayers: 0, playtimeSec: 0, revenueRobux: 0, purchases: 0, peakCcu: 0 });

export async function seriesForRange(db: Queryable, env: string, r: ResolvedRange, trackingStart: Date | null): Promise<SeriesPoint[]> {
  if (r.granularity === "day") return dailySeries(db, env, r.fromDay, r.toDay, r.tz, trackingStart);
  return hourlySeries(db, env, r.from, r.to, trackingStart);
}

/** When the aggregates were last recomputed: a missing bucket after that is "not computed yet" (null), not 0. */
async function rolledUntil(db: Queryable): Promise<Date | null> {
  const { rows } = await db.query<{ t: Date | null }>(
    `SELECT GREATEST((SELECT last_ok_at FROM job_state WHERE name = 'rollups'), (SELECT max(computed_at) FROM hourly_stats)) AS t`,
  );
  return rows[0]?.t ?? null;
}

export async function dailySeries(db: Queryable, env: string, fromDay: string, toDay: string, tz: string, trackingStart: Date | null): Promise<SeriesPoint[]> {
  const { rows } = await db.query(
    `SELECT day::text AS day, visits, sessions, dau, new_players, playtime_sec, revenue_robux, purchases, peak_ccu
     FROM daily_stats WHERE env = $1 AND day BETWEEN $2::date AND $3::date`,
    [env, fromDay, toDay],
  );
  const byDay = new Map(rows.map((x) => [x.day as string, x]));
  const startDay = trackingStart ? localDayOf(trackingStart, tz) : null;
  const until = await rolledUntil(db);
  const lastDay = until ? localDayOf(until, tz) : null;
  const out: SeriesPoint[] = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) {
    const x = byDay.get(d);
    if (x) {
      out.push({ t: d, visits: x.visits, sessions: x.sessions, players: x.dau, newPlayers: x.new_players, playtimeSec: Number(x.playtime_sec), revenueRobux: Number(x.revenue_robux), purchases: x.purchases, peakCcu: x.peak_ccu });
    } else out.push(startDay && lastDay && d >= startDay && d <= lastDay ? ZERO_POINT(d) : NULL_POINT(d));
  }
  return out;
}

export async function hourlySeries(db: Queryable, env: string, from: Date, to: Date, trackingStart: Date | null): Promise<SeriesPoint[]> {
  const { rows } = await db.query(
    `SELECT hour, visits, sessions, unique_players, new_players, playtime_sec, revenue_robux, purchases, peak_ccu
     FROM hourly_stats WHERE env = $1 AND hour >= date_trunc('hour', $2::timestamptz) AND hour < $3`,
    [env, from, to],
  );
  const byHour = new Map(rows.map((x) => [(x.hour as Date).toISOString(), x]));
  const out: SeriesPoint[] = [];
  const start = new Date(from);
  start.setUTCMinutes(0, 0, 0);
  const startHour = trackingStart ? new Date(Math.floor(trackingStart.getTime() / 3600_000) * 3600_000) : null;
  const until = await rolledUntil(db);
  for (let t = start.getTime(); t < to.getTime(); t += 3600_000) {
    const iso = new Date(t).toISOString();
    const x = byHour.get(iso);
    if (x) {
      out.push({ t: iso, visits: x.visits, sessions: x.sessions, players: x.unique_players, newPlayers: x.new_players, playtimeSec: Number(x.playtime_sec), revenueRobux: Number(x.revenue_robux), purchases: x.purchases, peakCcu: x.peak_ccu });
    } else out.push(startHour && until && t >= startHour.getTime() && t <= until.getTime() ? ZERO_POINT(iso) : NULL_POINT(iso));
  }
  return out;
}

/** CCU per bucket from ccu_minutes: max of per-minute peaks. bucketMin = 1 gives the raw minutes. */
export async function ccuSeries(db: Queryable, env: string, from: Date, to: Date, bucketMin: number) {
  const { rows } = await db.query<{ t: Date; peak: number; last: number; servers: number }>(
    `SELECT to_timestamp(floor(EXTRACT(EPOCH FROM minute) / ($4 * 60)) * ($4 * 60)) AS t,
            max(peak_ccu) AS peak, (array_agg(last_ccu ORDER BY minute DESC))[1] AS last, max(servers) AS servers
     FROM ccu_minutes WHERE env = $1 AND minute >= $2 AND minute < $3
     GROUP BY 1 ORDER BY 1`,
    [env, from, to, bucketMin],
  );
  const byT = new Map(rows.map((r) => [r.t.getTime(), r]));
  const out: Array<{ t: string; ccu: number | null; servers: number | null }> = [];
  const step = bucketMin * 60_000;
  for (let t = Math.floor(from.getTime() / step) * step; t < to.getTime(); t += step) {
    const r = byT.get(t);
    out.push({ t: new Date(t).toISOString(), ccu: r ? r.peak : null, servers: r ? r.servers : null });
  }
  return out;
}

export function localDayOf(at: Date, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** 0..23 local hour-of-day histogram from hourly_stats (UTC hours mapped into the reporting zone). */
export async function hourOfDay(db: Queryable, env: string, from: Date, to: Date, tz: string) {
  const { rows } = await db.query<{ h: number; visits: string; playtime: string; robux: string; purchases: string }>(
    `SELECT EXTRACT(HOUR FROM hour AT TIME ZONE $4)::int AS h, sum(visits) AS visits, sum(playtime_sec) AS playtime,
            sum(revenue_robux) AS robux, sum(purchases) AS purchases
     FROM hourly_stats WHERE env = $1 AND hour >= date_trunc('hour', $2::timestamptz) AND hour < $3 GROUP BY 1`,
    [env, from, to, tz],
  );
  const by = new Map(rows.map((r) => [r.h, r]));
  return Array.from({ length: 24 }, (_, h) => {
    const r = by.get(h);
    return { hour: h, visits: Number(r?.visits ?? 0), playtimeSec: Number(r?.playtime ?? 0), revenueRobux: Number(r?.robux ?? 0), purchases: Number(r?.purchases ?? 0) };
  });
}
