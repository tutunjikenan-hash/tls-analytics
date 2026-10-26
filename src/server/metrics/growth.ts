import type { Queryable } from "../db";
import * as core from "./core";
import { context, describeRange, freshness, knownPrevious, robloxReported } from "./overview";
import type { RangeQuery } from "./range";
import { seriesForRange } from "./series";

/**
 * Player growth. Only what game servers can observe reliably is measured; the rest is listed in
 * `unavailable` so the page can say so instead of showing made-up numbers.
 */
export async function growthPage(db: Queryable, q: RangeQuery, now = new Date()) {
  const { trackingStart, range: r } = await context(db, q, now);
  const prevW = knownPrevious(r, trackingStart);
  const env = q.env;
  const [newP, newPrev, active, totalPlayers, countries, referred, reportedHistory, devices] = await Promise.all([
    core.newPlayers(db, env, r),
    prevW ? core.newPlayers(db, env, prevW) : null,
    core.uniquePlayers(db, env, r),
    db.query<{ n: string }>(`SELECT count(*) AS n FROM players WHERE env = $1 AND first_seen_at < $2`, [env, r.to]),
    db.query(
      `SELECT COALESCE(country, '??') AS country, count(*) AS n FROM players WHERE env = $1 AND first_seen_at >= $2 AND first_seen_at < $3
       GROUP BY 1 ORDER BY 2 DESC LIMIT 25`,
      [env, r.from, r.to],
    ),
    db.query(
      `SELECT count(*) FILTER (WHERE referred) AS referred, count(*) AS visits FROM sessions
       WHERE env = $1 AND started_at >= $2 AND started_at < $3 AND visit_id = session_id`,
      [env, r.from, r.to],
    ),
    db.query(
      `SELECT metric, value, as_of FROM roblox_reported WHERE metric IN ('visits','favorites','playing') AND as_of >= $1 AND as_of < $2
       ORDER BY as_of`,
      [r.from, r.to],
    ),
    db.query(`SELECT name, sum(value) AS n FROM server_counters WHERE env = $1 AND name LIKE 'device_%' AND minute >= date_trunc('minute',$2::timestamptz) AND minute < $3 GROUP BY 1`, [env, r.from, r.to]),
  ]);

  const series = trackingStart ? await seriesForRange(db, env, r, trackingStart) : [];
  // cumulative unique players up to each bucket end
  const base = Number(totalPlayers.rows[0].n) - newP;
  let run = base;
  const cumulative = series.map((p) => {
    if (p.newPlayers === null) return { t: p.t, players: null as number | null };
    run += p.newPlayers;
    return { t: p.t, players: run };
  });
  const reportedByMetric: Record<string, Array<{ t: string; value: number }>> = {};
  for (const x of reportedHistory.rows) (reportedByMetric[x.metric] ??= []).push({ t: (x.as_of as Date).toISOString(), value: Number(x.value) });

  return {
    range: describeRange(r),
    env,
    generatedAt: now.toISOString(),
    hasData: trackingStart !== null,
    freshness: await freshness(db, env),
    newPlayers: newP,
    newPlayersPrev: newPrev,
    newPlayersChangePct: core.pctChange(newP, newPrev),
    activePlayers: active,
    newShareOfActivePct: active > 0 ? (newP / active) * 100 : null,
    totalPlayersTracked: Number(totalPlayers.rows[0].n),
    countriesOfNewPlayers: countries.rows.map((x) => ({ country: x.country as string, players: Number(x.n) })),
    shareLinkVisits: { referred: Number(referred.rows[0].referred), visits: Number(referred.rows[0].visits) },
    devices: devices.rows.map((x) => ({ device: String(x.name).replace("device_", ""), sessions: Number(x.n) })),
    robloxReported: await robloxReported(db),
    robloxReportedHistory: reportedByMetric,
    series,
    cumulative,
    unavailable: [
      { metric: "Traffic sources (home sort, search, sponsored, recommendations)", why: "Roblox does not expose them to game servers. See Creator Dashboard → Analytics → Acquisition." },
      { metric: "Impressions and play-button conversion", why: "Only Roblox sees experience-page impressions. See Creator Dashboard → Acquisition." },
      { metric: "Age group, gender, platform split (official)", why: "Not available to game servers. The device split here is what the client reports (indicative only)." },
    ],
  };
}
