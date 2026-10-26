import type { Queryable } from "../db";
import { addDays } from "../jobs/rollups";
import * as core from "./core";
import { context, describeRange, freshness, knownPrevious } from "./overview";
import type { RangeQuery } from "./range";
import { hourOfDay, localDayOf, seriesForRange } from "./series";

const LENGTH_BUCKETS = [1, 5, 10, 20, 30, 60, 120]; // minutes
const LENGTH_LABELS = ["<1m", "1-5m", "5-10m", "10-20m", "20-30m", "30-60m", "1-2h", "2h+"];

export async function engagementPage(db: Queryable, q: RangeQuery, now = new Date()) {
  const { settings, trackingStart, range: r } = await context(db, q, now);
  const prevW = knownPrevious(r, trackingStart);
  const env = q.env;
  const tz = settings.reporting_timezone;
  const endDay = r.toDay;

  const [lengths, lengthsPrev, playtime, playtimePrev, sessions, players, playersPrev, newP, dist, dau, wau, mau, avgDau30, churn] = await Promise.all([
    core.visitLengths(db, env, r), prevW ? core.visitLengths(db, env, prevW) : null,
    core.playtimeSeconds(db, env, r), prevW ? core.playtimeSeconds(db, env, prevW) : null,
    core.sessionsStarted(db, env, r),
    core.uniquePlayers(db, env, r), prevW ? core.uniquePlayers(db, env, prevW) : null,
    core.newPlayers(db, env, r),
    db.query(
      `WITH v AS (
         SELECT visit_id, min(started_at) AS vstart, EXTRACT(EPOCH FROM max(COALESCE(ended_at, last_seen_at)) - min(started_at)) / 60 AS mins
         FROM sessions WHERE env = $1 AND started_at >= $2::timestamptz - interval '1 day' AND started_at < $3::timestamptz + interval '1 day'
         GROUP BY visit_id HAVING bool_and(ended_at IS NOT NULL))
       SELECT width_bucket(mins::float8, $4::float8[]) AS b, count(*) AS n FROM v WHERE vstart >= $2 AND vstart < $3 GROUP BY 1`,
      [env, r.from, r.to, LENGTH_BUCKETS],
    ),
    core.uniquePlayersDays(db, env, endDay, endDay),
    core.uniquePlayersDays(db, env, addDays(endDay, -6), endDay),
    core.uniquePlayersDays(db, env, addDays(endDay, -29), endDay),
    db.query<{ a: number | null }>(`SELECT avg(dau)::float8 AS a FROM daily_stats WHERE env = $1 AND day BETWEEN $2::date AND $3::date`, [env, addDays(endDay, -29), endDay]),
    churnFor(db, env, prevW ? { fromDay: prevW.fromDay, toDay: prevW.toDay } : null, { fromDay: r.fromDay, toDay: r.toDay }, r.wholeDays),
  ]);

  const byB = new Map(dist.rows.map((x) => [Number(x.b), Number(x.n)]));
  const avgDau = avgDau30.rows[0].a;
  const trackedDays = trackingStart ? Math.min(30, dayDiff(localDayOf(trackingStart, tz), endDay) + 1) : 0;

  return {
    range: describeRange(r),
    env,
    generatedAt: now.toISOString(),
    hasData: trackingStart !== null,
    freshness: await freshness(db, env),
    visitLength: { ...lengths, previousAvgSec: lengthsPrev?.avgSec ?? null, changePct: core.pctChange(lengths.avgSec, lengthsPrev?.avgSec ?? null) },
    totalPlaytimeSec: playtime,
    totalPlaytimePrevSec: playtimePrev,
    playtimePerPlayerSec: players > 0 ? playtime / players : null,
    sessions,
    sessionsPerPlayer: players > 0 ? sessions / players : null,
    activePlayers: players,
    activePlayersPrev: playersPrev,
    newPlayers: newP,
    returningPlayers: players - newP,
    dau, wau, mau,
    /** stickiness = average DAU over the last 30 days / MAU; only meaningful once 30 days are tracked */
    stickinessPct: mau > 0 && avgDau !== null ? (avgDau / mau) * 100 : null,
    stickinessBasisDays: trackedDays,
    churn,
    lengthDistribution: LENGTH_LABELS.map((label, i) => ({ bucket: label, visits: byB.get(i) ?? 0 })),
    series: trackingStart ? await seriesForRange(db, env, r, trackingStart) : [],
    byHourOfDay: await hourOfDay(db, env, r.from, r.to, tz),
  };
}

/**
 * Churn between two equal periods of whole days: of the players active in the previous period, the
 * share not active at all in the current one. Not computed for sub-day ranges or when the previous
 * period is before tracking (we would be inventing a base).
 */
async function churnFor(db: Queryable, env: string, prev: { fromDay: string; toDay: string } | null, cur: { fromDay: string; toDay: string }, wholeDays: boolean) {
  if (!prev || !wholeDays) return null;
  const { rows } = await db.query<{ base: string; kept: string }>(
    `WITH p AS (SELECT DISTINCT player_key FROM player_days WHERE env = $1 AND day BETWEEN $2::date AND $3::date),
          c AS (SELECT DISTINCT player_key FROM player_days WHERE env = $1 AND day BETWEEN $4::date AND $5::date)
     SELECT (SELECT count(*) FROM p) AS base, (SELECT count(*) FROM p JOIN c USING (player_key)) AS kept`,
    [env, prev.fromDay, prev.toDay, cur.fromDay, cur.toDay],
  );
  const base = Number(rows[0].base);
  if (base === 0) return null;
  const kept = Number(rows[0].kept);
  return { previousActive: base, stillActive: kept, churned: base - kept, churnPct: ((base - kept) / base) * 100 };
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** Retention page: calendar-day cohorts (see jobs/rollups.ts rollupRetention). */
export async function retentionPage(db: Queryable, q: RangeQuery, now = new Date()) {
  const { settings, trackingStart, range: r } = await context(db, q, now);
  const env = q.env;
  const tz = settings.reporting_timezone;
  // cohorts: the selected range (whole days), capped to the most recent 60 cohort days
  const fromDay = r.preset === "live" || r.preset === "today" ? addDays(r.toDay, -29) : r.fromDay;
  const { rows } = await db.query(
    `SELECT cohort_day::text AS c, day_offset AS n, cohort_size AS size, retained FROM retention_cohorts
     WHERE env = $1 AND cohort_day BETWEEN GREATEST($2::date, $3::date - 59) AND $3::date ORDER BY cohort_day DESC, day_offset`,
    [env, fromDay, r.toDay],
  );
  const firstDay = trackingStart ? localDayOf(trackingStart, tz) : null;
  const cohorts = new Map<string, { day: string; size: number; cells: Record<number, number>; includesPreTracking: boolean }>();
  for (const x of rows) {
    const c = cohorts.get(x.c) ?? { day: x.c as string, size: Number(x.size), cells: {} as Record<number, number>, includesPreTracking: x.c === firstDay };
    c.cells[Number(x.n)] = Number(x.retained);
    cohorts.set(x.c, c);
  }
  const list = [...cohorts.values()];
  // summary: cohort-size weighted, only over cohorts where that day is complete, excluding the first
  // tracked day (its "new" players include everyone who simply played that day)
  const summary = Object.fromEntries(
    [1, 3, 7, 14, 30].map((n) => {
      const eligible = list.filter((c) => c.cells[n] !== undefined && !c.includesPreTracking);
      const size = eligible.reduce((a, c) => a + c.size, 0);
      const kept = eligible.reduce((a, c) => a + c.cells[n], 0);
      return [`d${n}`, { pct: size > 0 ? (kept / size) * 100 : null, cohorts: eligible.length, players: size }];
    }),
  );
  // retention curve: average across eligible cohorts per offset
  const curve = Array.from({ length: 31 }, (_, n) => {
    const eligible = list.filter((c) => c.cells[n] !== undefined && !c.includesPreTracking);
    const size = eligible.reduce((a, c) => a + c.size, 0);
    return { day: n, pct: size > 0 ? (eligible.reduce((a, c) => a + c.cells[n], 0) / size) * 100 : null, cohorts: eligible.length };
  });
  return {
    range: describeRange(r),
    env,
    generatedAt: now.toISOString(),
    hasData: trackingStart !== null,
    trackingSince: trackingStart?.toISOString() ?? null,
    timezone: tz,
    summary,
    curve,
    cohorts: list,
    method:
      "Calendar-day cohorts in the reporting time zone. A player belongs to the cohort of the day they were first observed. Day N retention = cohort players active on cohort day + N. Cells appear only once that day is over; the first tracked day is flagged because it includes players who started before tracking.",
  };
}
