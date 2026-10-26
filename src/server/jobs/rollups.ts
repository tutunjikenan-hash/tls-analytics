import type { Queryable } from "../db";

/**
 * Aggregate tables. All of them are recomputed (not incremented), so running a rollup twice, or
 * after late events arrive, always converges on the same exact values.
 *
 *   player_days        one row per player per reporting-time-zone day with activity (exact DAU/WAU/MAU)
 *   hourly_stats       per UTC hour
 *   daily_stats        per reporting-time-zone day
 *   retention_cohorts  D0..D30 per first-seen cohort day (only for days that are fully over)
 */

/** Adds player_days rows for sessions active since `since` (cheap; ON CONFLICT DO NOTHING). */
export async function rollupPlayerDays(db: Queryable, tz: string, since: Date): Promise<number> {
  const res = await db.query(
    `INSERT INTO player_days (env, day, player_key)
     SELECT DISTINCT s.env, d::date, s.player_key
     FROM sessions s,
          LATERAL generate_series((s.started_at AT TIME ZONE $1)::date,
                                  (COALESCE(s.ended_at, s.last_seen_at) AT TIME ZONE $1)::date, interval '1 day') AS d
     WHERE COALESCE(s.ended_at, s.last_seen_at) >= $2
     ON CONFLICT DO NOTHING`,
    [tz, since],
  );
  return res.rowCount ?? 0;
}

/** Rebuilds player_days from scratch (after a reporting time zone change). */
export async function rebuildPlayerDays(db: Queryable, tz: string): Promise<void> {
  await db.query(`DELETE FROM player_days`);
  await rollupPlayerDays(db, tz, new Date(0));
}

/** Recomputes hourly_stats for every UTC hour in [from, to). */
export async function rollupHours(db: Queryable, from: Date, to: Date): Promise<number> {
  const res = await db.query(
    `WITH hours AS (
       SELECT e.env, h AS hour, h + interval '1 hour' AS hend
       FROM unnest(ARRAY['production','studio','simulation']) AS e(env),
            generate_series(date_trunc('hour', $1::timestamptz), date_trunc('hour', $2::timestamptz - interval '1 microsecond'), interval '1 hour') AS h
     ),
     s AS (
       SELECT h.env, h.hour,
         count(*) FILTER (WHERE x.started_at >= h.hour AND x.started_at < h.hend) AS sessions,
         count(*) FILTER (WHERE x.started_at >= h.hour AND x.started_at < h.hend AND x.visit_id = x.session_id) AS visits,
         count(DISTINCT x.player_key) AS unique_players,
         COALESCE(sum(GREATEST(0, EXTRACT(EPOCH FROM LEAST(COALESCE(x.ended_at, x.last_seen_at), h.hend) - GREATEST(x.started_at, h.hour)))), 0)::bigint AS playtime,
         count(*) FILTER (WHERE x.ended_at >= h.hour AND x.ended_at < h.hend) AS leaves
       FROM hours h JOIN sessions x ON x.env = h.env AND x.started_at < h.hend AND COALESCE(x.ended_at, x.last_seen_at) >= h.hour
       GROUP BY h.env, h.hour),
     np AS (SELECT h.env, h.hour, count(p.*) AS n FROM hours h JOIN players p ON p.env = h.env AND p.first_seen_at >= h.hour AND p.first_seen_at < h.hend GROUP BY 1,2),
     rv AS (SELECT h.env, h.hour, COALESCE(sum(pu.robux_gross),0) AS robux, count(pu.*) AS n
            FROM hours h JOIN purchases pu ON pu.env = h.env AND pu.purchased_at >= h.hour AND pu.purchased_at < h.hend
                                         AND pu.status = 'confirmed' AND pu.refunded_at IS NULL GROUP BY 1,2),
     cc AS (SELECT h.env, h.hour, max(c.peak_ccu) AS peak FROM hours h JOIN ccu_minutes c ON c.env = h.env AND c.minute >= h.hour AND c.minute < h.hend GROUP BY 1,2),
     agg AS (
       SELECT h.env, h.hour,
         COALESCE(s.visits,0) AS visits, COALESCE(s.sessions,0) AS sessions, COALESCE(s.unique_players,0) AS unique_players,
         COALESCE(np.n,0) AS new_players, COALESCE(s.playtime,0) AS playtime, COALESCE(rv.robux,0) AS robux, COALESCE(rv.n,0) AS purchases,
         COALESCE(cc.peak,0) AS peak, COALESCE(s.sessions,0) AS joins, COALESCE(s.leaves,0) AS leaves
       FROM hours h LEFT JOIN s USING (env, hour) LEFT JOIN np USING (env, hour) LEFT JOIN rv USING (env, hour) LEFT JOIN cc USING (env, hour)
     )
     INSERT INTO hourly_stats (env, hour, visits, sessions, unique_players, new_players, playtime_sec, revenue_robux, purchases, peak_ccu, joins, leaves, computed_at)
     SELECT env, hour, visits, sessions, unique_players, new_players, playtime, robux, purchases, peak, joins, leaves, now() FROM agg
     WHERE visits + sessions + unique_players + new_players + playtime + robux + purchases + peak + leaves > 0
        OR EXISTS (SELECT 1 FROM hourly_stats hs WHERE hs.env = agg.env AND hs.hour = agg.hour)
     ON CONFLICT (env, hour) DO UPDATE SET visits = EXCLUDED.visits, sessions = EXCLUDED.sessions, unique_players = EXCLUDED.unique_players,
       new_players = EXCLUDED.new_players, playtime_sec = EXCLUDED.playtime_sec, revenue_robux = EXCLUDED.revenue_robux,
       purchases = EXCLUDED.purchases, peak_ccu = EXCLUDED.peak_ccu, joins = EXCLUDED.joins, leaves = EXCLUDED.leaves, computed_at = now()`,
    [from, to],
  );
  return res.rowCount ?? 0;
}

/** Recomputes daily_stats for reporting days [fromDay, toDay] (inclusive, 'YYYY-MM-DD'). */
export async function rollupDays(db: Queryable, tz: string, fromDay: string, toDay: string): Promise<number> {
  const res = await db.query(
    `WITH days AS (
       SELECT e.env, d::date AS day, (d::timestamp AT TIME ZONE $1) AS ds, ((d + interval '1 day')::timestamp AT TIME ZONE $1) AS de
       FROM unnest(ARRAY['production','studio','simulation']) AS e(env),
            generate_series($2::date, $3::date, interval '1 day') AS d
     ),
     ses AS (
       SELECT d.env, d.day,
         count(*) FILTER (WHERE x.started_at >= d.ds AND x.started_at < d.de) AS sessions,
         count(*) FILTER (WHERE x.started_at >= d.ds AND x.started_at < d.de AND x.visit_id = x.session_id) AS visits,
         COALESCE(sum(GREATEST(0, EXTRACT(EPOCH FROM LEAST(COALESCE(x.ended_at, x.last_seen_at), d.de) - GREATEST(x.started_at, d.ds)))),0)::bigint AS playtime
       FROM days d JOIN sessions x ON x.env = d.env AND x.started_at < d.de AND COALESCE(x.ended_at, x.last_seen_at) >= d.ds
       GROUP BY 1,2),
     vis AS (   -- closed visits that started that day: duration = first join .. last leave across linked sessions
       SELECT d.env, d.day, avg(v.dur) AS avg_dur, percentile_cont(0.5) WITHIN GROUP (ORDER BY v.dur) AS med_dur
       FROM days d JOIN (
         SELECT env, visit_id, min(started_at) AS vstart, EXTRACT(EPOCH FROM max(COALESCE(ended_at, last_seen_at)) - min(started_at)) AS dur
         FROM sessions WHERE started_at >= (($2::date - 2)::timestamp AT TIME ZONE $1)
         GROUP BY env, visit_id HAVING bool_and(ended_at IS NOT NULL)
       ) v ON v.env = d.env AND v.vstart >= d.ds AND v.vstart < d.de
       GROUP BY 1,2),
     dau AS (SELECT d.env, d.day, count(*) AS n FROM days d JOIN player_days pd ON pd.env = d.env AND pd.day = d.day GROUP BY 1,2),
     np AS (SELECT d.env, d.day, count(*) AS n FROM days d JOIN players p ON p.env = d.env AND p.first_seen_at >= d.ds AND p.first_seen_at < d.de GROUP BY 1,2),
     rv AS (SELECT d.env, d.day, COALESCE(sum(pu.robux_gross),0) AS robux, COALESCE(sum(pu.estimated_creator_robux),0) AS est,
                   count(*) AS n, count(DISTINCT pu.player_key) AS payers
            FROM days d JOIN purchases pu ON pu.env = d.env AND pu.purchased_at >= d.ds AND pu.purchased_at < d.de
                                         AND pu.status = 'confirmed' AND pu.refunded_at IS NULL GROUP BY 1,2),
     cc AS (SELECT d.env, d.day, max(c.peak_ccu) AS peak FROM days d JOIN ccu_minutes c ON c.env = d.env AND c.minute >= d.ds AND c.minute < d.de GROUP BY 1,2),
     agg AS (
       SELECT d.env, d.day,
         COALESCE(ses.visits,0) AS visits, COALESCE(ses.sessions,0) AS sessions, COALESCE(dau.n,0) AS dau, COALESCE(np.n,0) AS newp,
         COALESCE(ses.playtime,0) AS playtime, vis.avg_dur, vis.med_dur,
         COALESCE(rv.robux,0) AS robux, COALESCE(rv.est,0) AS est, COALESCE(rv.n,0) AS purchases, COALESCE(rv.payers,0) AS payers, COALESCE(cc.peak,0) AS peak
       FROM days d LEFT JOIN ses USING (env, day) LEFT JOIN vis USING (env, day) LEFT JOIN dau USING (env, day)
                   LEFT JOIN np USING (env, day) LEFT JOIN rv USING (env, day) LEFT JOIN cc USING (env, day)
     )
     INSERT INTO daily_stats (env, day, timezone, visits, sessions, dau, new_players, returning_players, playtime_sec,
                              avg_visit_sec, median_visit_sec, revenue_robux, est_creator_robux, purchases, paying_users, peak_ccu, computed_at)
     SELECT env, day, $1, visits, sessions, dau, newp, GREATEST(dau - newp, 0), playtime, avg_dur, med_dur, robux, est, purchases, payers, peak, now()
     FROM agg
     WHERE visits + sessions + dau + newp + playtime + robux + peak > 0
        OR EXISTS (SELECT 1 FROM daily_stats ds2 WHERE ds2.env = agg.env AND ds2.day = agg.day)
     ON CONFLICT (env, day) DO UPDATE SET timezone = EXCLUDED.timezone, visits = EXCLUDED.visits, sessions = EXCLUDED.sessions,
       dau = EXCLUDED.dau, new_players = EXCLUDED.new_players, returning_players = EXCLUDED.returning_players,
       playtime_sec = EXCLUDED.playtime_sec, avg_visit_sec = EXCLUDED.avg_visit_sec, median_visit_sec = EXCLUDED.median_visit_sec,
       revenue_robux = EXCLUDED.revenue_robux, est_creator_robux = EXCLUDED.est_creator_robux, purchases = EXCLUDED.purchases,
       paying_users = EXCLUDED.paying_users, peak_ccu = EXCLUDED.peak_ccu, computed_at = now()`,
    [tz, fromDay, toDay],
  );
  return res.rowCount ?? 0;
}

/**
 * Calendar-day retention. Cohort = players whose first observed session falls on day C (reporting
 * time zone). Retained on day C+N = cohort players with any activity on day C+N. A (cohort, N) cell is
 * only written once day C+N is completely over; until then it does not exist (shown as "not yet"),
 * and it is never written as 0 for days before tracking started.
 */
export async function rollupRetention(db: Queryable, tz: string, todayLocal: string, maxOffset = 30, lookbackDays = 120): Promise<number> {
  const res = await db.query(
    `WITH cohort AS (
       SELECT env, player_key, (first_seen_at AT TIME ZONE $1)::date AS cday
       FROM players WHERE (first_seen_at AT TIME ZONE $1)::date >= $2::date - $4::int
     ),
     sizes AS (SELECT env, cday, count(*) AS size FROM cohort GROUP BY 1,2),
     offsets AS (SELECT generate_series(0, $3::int) AS n),
     cells AS (
       SELECT s.env, s.cday, o.n, s.size FROM sizes s CROSS JOIN offsets o
       WHERE s.cday + o.n < $2::date            -- day C+N must be over
     ),
     ret AS (
       SELECT c.env, c.cday, (pd.day - c.cday) AS n, count(*) AS retained
       FROM cohort c JOIN player_days pd ON pd.env = c.env AND pd.player_key = c.player_key
        AND pd.day >= c.cday AND pd.day <= c.cday + $3::int AND pd.day < $2::date
       GROUP BY 1,2,3)
     INSERT INTO retention_cohorts (env, cohort_day, day_offset, cohort_size, retained, timezone, computed_at)
     SELECT cells.env, cells.cday, cells.n, cells.size, COALESCE(ret.retained, 0), $1, now()
     FROM cells LEFT JOIN ret ON ret.env = cells.env AND ret.cday = cells.cday AND ret.n = cells.n
     ON CONFLICT (env, cohort_day, day_offset) DO UPDATE SET cohort_size = EXCLUDED.cohort_size, retained = EXCLUDED.retained,
       timezone = EXCLUDED.timezone, computed_at = now()`,
    [tz, todayLocal, maxOffset, lookbackDays],
  );
  return res.rowCount ?? 0;
}

/** 'YYYY-MM-DD' of `at` in time zone tz */
export function localDay(at: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  return p; // en-CA formats as YYYY-MM-DD
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
