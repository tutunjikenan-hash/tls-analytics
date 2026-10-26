import type { Queryable } from "../db";
import { getSettings } from "../settings";
import * as core from "./core";
import { resolveRange, type RangeQuery, type ResolvedRange, type Window } from "./range";
import { ccuSeries, envTrackingStart, seriesForRange } from "./series";

export interface Kpi {
  value: number | null;
  previous: number | null;
  changePct: number | null;
  unit?: "count" | "seconds" | "robux" | "percent";
  note?: string;
}

const kpi = (value: number | null, previous: number | null, unit: Kpi["unit"] = "count", note?: string): Kpi => ({
  value, previous, changePct: core.pctChange(value, previous), unit, ...(note ? { note } : {}),
});

/** Everything metric pages share: settings, resolved range and data freshness. */
export async function context(db: Queryable, q: RangeQuery, now = new Date()) {
  const s = await getSettings(db);
  const trackingStart = await envTrackingStart(db, q.env);
  const range = await resolveRange(db, q, s.reporting_timezone, now, trackingStart);
  return { settings: s, trackingStart, range, now };
}

export async function freshness(db: Queryable, env: string) {
  const { rows } = await db.query<{ last_event: Date | null; rollup_ok: Date | null; ccu_ok: Date | null }>(
    `SELECT (SELECT max(received_at) FROM raw_events WHERE env = $1) AS last_event,
            (SELECT last_ok_at FROM job_state WHERE name = 'rollups') AS rollup_ok,
            (SELECT last_ok_at FROM job_state WHERE name = 'live') AS ccu_ok`,
    [env],
  );
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return { lastEventAt: iso(rows[0].last_event), rollupsAt: iso(rows[0].rollup_ok), liveJobAt: iso(rows[0].ccu_ok) };
}

/** Active players for a range: exact distinct count (sessions overlapping the window). */
async function active(db: Queryable, env: string, w: Window) {
  return core.uniquePlayers(db, env, w);
}

export async function overview(db: Queryable, q: RangeQuery, now = new Date()) {
  const { settings, trackingStart, range } = await context(db, q, now);
  const env = q.env;
  const r = range;
  const prev = r.previous;
  const tz = settings.reporting_timezone;
  const hasData = trackingStart !== null;

  const fixed = async (preset: "today" | "7d" | "30d") => resolveRange(db, { range: preset, env }, tz, now, trackingStart);
  const [today, d7, d30] = await Promise.all([fixed("today"), fixed("7d"), fixed("30d")]);

  const [live, visits, visitsPrev, sessions, sessionsPrev, players, playersPrev, newP, newPPrev, playtime, playtimePrev, lengths, lengthsPrev,
    peak, peakPrev, rev, revPrev, revToday, rev7, rev30, revLife, lifeVisits, dau, wau, mau, reported] = await Promise.all([
    core.ccuNow(db, env, settings.session_timeout_seconds, now),
    core.visits(db, env, r), prev ? core.visits(db, env, prev) : null,
    core.sessionsStarted(db, env, r), prev ? core.sessionsStarted(db, env, prev) : null,
    active(db, env, r), prev ? active(db, env, prev) : null,
    core.newPlayers(db, env, r), prev ? core.newPlayers(db, env, prev) : null,
    core.playtimeSeconds(db, env, r), prev ? core.playtimeSeconds(db, env, prev) : null,
    core.visitLengths(db, env, r), prev ? core.visitLengths(db, env, prev) : null,
    core.peakCcu(db, env, r), prev ? core.peakCcu(db, env, prev) : null,
    core.revenue(db, env, r), prev ? core.revenue(db, env, prev) : null,
    core.revenue(db, env, today), core.revenue(db, env, d7), core.revenue(db, env, d30), core.lifetimeRevenue(db, env),
    core.lifetimeVisits(db, env),
    core.uniquePlayers(db, env, today),
    core.uniquePlayersDays(db, env, d7.fromDay, d7.toDay),
    core.uniquePlayersDays(db, env, d30.fromDay, d30.toDay),
    robloxReported(db),
  ]);
  const peakToday = await core.peakCcu(db, env, today);
  const sessionsToday = await core.sessionsStarted(db, env, today);
  const visitsToday = await core.visits(db, env, today);

  // before tracking began a previous period has no data: compare against nothing rather than 0
  const prevKnown = !!(prev && trackingStart && prev.to > trackingStart);
  const P = <T>(v: T) => (prevKnown ? v : null);
  const returning = players - newP;
  const returningPrev = playersPrev !== null && newPPrev !== null ? playersPrev - newPPrev : null;

  const series = hasData ? await seriesForRange(db, env, r, trackingStart) : [];
  const ccu24 = hasData ? await ccuSeries(db, env, new Date(now.getTime() - 24 * 3600_000), now, 5) : [];

  return {
    range: describeRange(r),
    env,
    generatedAt: now.toISOString(),
    trackingSince: trackingStart?.toISOString() ?? null,
    hasData,
    freshness: await freshness(db, env),
    live: {
      ccu: live.ccu, servers: live.servers, sessions: live.sessions,
      // the CCU sample is taken every 15 s: the current count is also a measurement of today's peak
      peakToday: peakToday.peak === null && live.ccu === 0 ? null : Math.max(peakToday.peak ?? 0, live.ccu),
      peakTodayAt: live.ccu > (peakToday.peak ?? 0) ? now.toISOString() : peakToday.at?.toISOString() ?? null,
    },
    kpis: {
      visits: kpi(visits, P(visitsPrev)),
      visitsToday: kpi(visitsToday, null),
      sessions: kpi(sessions, P(sessionsPrev)),
      sessionsToday: kpi(sessionsToday, null),
      activePlayers: kpi(players, P(playersPrev)),
      dau: kpi(dau, null),
      wau: kpi(wau, null),
      mau: kpi(mau, null),
      newPlayers: kpi(newP, P(newPPrev), "count", trackingStart && r.from <= trackingStart ? "Includes players who played before tracking began (first seen = first observed)." : undefined),
      returningPlayers: kpi(returning, P(returningPrev)),
      avgPlaytime: kpi(lengths.avgSec, P(lengthsPrev?.avgSec ?? null), "seconds", "Average closed visit length (first join to last leave)."),
      medianPlaytime: kpi(lengths.medianSec, P(lengthsPrev?.medianSec ?? null), "seconds"),
      totalPlaytime: kpi(playtime, P(playtimePrev), "seconds"),
      peakCcu: kpi(peak.peak, P(peakPrev?.peak ?? null)),
      revenue: kpi(rev.grossRobux, P(revPrev?.grossRobux ?? null), "robux"),
      revenueToday: kpi(revToday.grossRobux, null, "robux"),
      revenue7d: kpi(rev7.grossRobux, null, "robux"),
      revenue30d: kpi(rev30.grossRobux, null, "robux"),
      revenueLifetime: kpi(revLife.grossRobux, null, "robux", revLife.since ? `Tracked since ${revLife.since.toISOString()}` : undefined),
      lifetimeVisits: kpi(lifeVisits.visits, null, "count", lifeVisits.since ? `Tracked by this dashboard since ${lifeVisits.since.toISOString()}` : undefined),
    },
    robloxReported: reported,
    series,
    ccu24h: ccu24,
  };
}

/**
 * The comparison window, or null when it ends before tracking began: an unmeasured period must never
 * be shown as a real zero.
 */
export function knownPrevious(r: ResolvedRange, trackingStart: Date | null): Window | null {
  return r.previous && trackingStart && r.previous.to > trackingStart ? r.previous : null;
}

export function describeRange(r: ResolvedRange) {
  return {
    preset: r.preset, label: r.label, tz: r.tz, from: r.from.toISOString(), to: r.to.toISOString(), fromDay: r.fromDay, toDay: r.toDay,
    granularity: r.granularity, complete: r.complete,
    previous: r.previous ? { from: r.previous.from.toISOString(), to: r.previous.to.toISOString(), fromDay: r.previous.fromDay, toDay: r.previous.toDay } : null,
  };
}

/** Latest public numbers Roblox reports (games API), shown separately from our own tracking. */
export async function robloxReported(db: Queryable) {
  const { rows } = await db.query<{ metric: string; value: string; as_of: Date; source: string }>(
    `SELECT DISTINCT ON (metric) metric, value, as_of, source FROM roblox_reported ORDER BY metric, as_of DESC`,
  );
  const out: Record<string, { value: number; asOf: string; source: string }> = {};
  for (const r of rows) out[r.metric] = { value: Number(r.value), asOf: r.as_of.toISOString(), source: r.source };
  return out;
}
