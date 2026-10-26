import type { Queryable } from "../db";
import { getSettings } from "../settings";
import * as core from "./core";
import { resolveRange, type RangeQuery } from "./range";
import { ccuSeries, envTrackingStart } from "./series";

/**
 * Live page. Everything here is read directly from the base tables (no rollups), so it is current to
 * the latest ingested heartbeat (game servers send every 10 s; the dashboard streams every 5 s).
 * "Live" means: an open session whose last heartbeat is within the session timeout.
 */
export async function livePage(db: Queryable, env: RangeQuery["env"], now = new Date()) {
  const s = await getSettings(db);
  const timeout = s.session_timeout_seconds;
  const trackingStart = await envTrackingStart(db, env);
  const today = await resolveRange(db, { range: "today", env }, s.reporting_timezone, now, trackingStart);
  const hourAgo = new Date(now.getTime() - 3600_000);
  const fresh = `env = $1 AND ended_at IS NULL AND last_seen_at >= $2::timestamptz - make_interval(secs => $3)`;
  const args = [env, now, timeout];

  const [current, peakToday, servers, stages, durations, regions, perMinute, ccu60, ccu24] = await Promise.all([
    core.ccuNow(db, env, timeout, now),
    core.peakCcu(db, env, today),
    db.query(
      `SELECT sv.server_id, sv.server_kind, sv.place_version, sv.started_at, sv.last_heartbeat_at, sv.fps, sv.memory_mb, sv.uptime_sec,
              (SELECT count(DISTINCT player_key) FROM sessions se WHERE se.env = sv.env AND se.server_id = sv.server_id AND se.ended_at IS NULL
                 AND se.last_seen_at >= $2::timestamptz - make_interval(secs => $3)) AS players
       FROM servers sv WHERE sv.env = $1 AND sv.ended_at IS NULL AND sv.last_heartbeat_at >= $2::timestamptz - make_interval(secs => $3)
       ORDER BY players DESC, sv.started_at`,
      args,
    ),
    db.query(`SELECT COALESCE(stage, 'unknown') AS stage, count(DISTINCT player_key) AS n FROM sessions WHERE ${fresh} GROUP BY 1 ORDER BY 2 DESC`, args),
    db.query(
      `SELECT width_bucket((EXTRACT(EPOCH FROM $2::timestamptz - started_at) / 60)::float8, ARRAY[5,10,20,30,60,120]::float8[]) AS b, count(*) AS n
       FROM sessions WHERE ${fresh} GROUP BY 1`,
      args,
    ),
    db.query(`SELECT COALESCE(country, '??') AS country, count(DISTINCT player_key) AS n FROM sessions WHERE ${fresh} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, args),
    db.query(
      `WITH m AS (SELECT generate_series(date_trunc('minute', $2::timestamptz), date_trunc('minute', $3::timestamptz), interval '1 minute') AS minute)
       SELECT m.minute,
         (SELECT count(*) FROM sessions s WHERE s.env = $1 AND s.started_at >= m.minute AND s.started_at < m.minute + interval '1 minute') AS joins,
         (SELECT count(*) FROM sessions s WHERE s.env = $1 AND s.ended_at >= m.minute AND s.ended_at < m.minute + interval '1 minute') AS leaves
       FROM m ORDER BY m.minute`,
      [env, hourAgo, now],
    ),
    ccuSeries(db, env, hourAgo, now, 1),
    ccuSeries(db, env, new Date(now.getTime() - 24 * 3600_000), now, 5),
  ]);

  const labels = ["<5m", "5-10m", "10-20m", "20-30m", "30-60m", "1-2h", "2h+"];
  const durBy = new Map(durations.rows.map((r) => [Number(r.b), Number(r.n)]));
  const playersPerServer = servers.rows.map((r) => Number(r.players));
  const minutes = perMinute.rows.map((r) => ({ t: (r.minute as Date).toISOString(), joins: Number(r.joins), leaves: Number(r.leaves) }));
  const last5 = minutes.slice(-6, -1); // last 5 complete minutes
  const avg = (k: "joins" | "leaves") => (last5.length ? last5.reduce((a, m) => a + m[k], 0) / last5.length : 0);

  return {
    env,
    generatedAt: now.toISOString(),
    hasData: trackingStart !== null,
    sessionTimeoutSec: timeout,
    tz: s.reporting_timezone,
    ccu: current.ccu,
    sessions: current.sessions,
    servers: current.servers,
    peakToday: peakToday.peak === null && current.ccu === 0 ? null : Math.max(peakToday.peak ?? 0, current.ccu),
    peakTodayAt: current.ccu > (peakToday.peak ?? 0) ? now.toISOString() : peakToday.at?.toISOString() ?? null,
    avgPlayersPerServer: playersPerServer.length ? playersPerServer.reduce((a, b) => a + b, 0) / playersPerServer.length : null,
    joinsPerMin: avg("joins"),
    leavesPerMin: avg("leaves"),
    serverList: servers.rows.map((r) => ({
      serverId: r.server_id as string,
      kind: r.server_kind as string | null,
      placeVersion: r.place_version as number | null,
      players: Number(r.players),
      fps: r.fps === null ? null : Number(r.fps),
      memoryMb: r.memory_mb === null ? null : Number(r.memory_mb),
      uptimeSec: r.uptime_sec === null ? null : Number(r.uptime_sec),
      startedAt: (r.started_at as Date).toISOString(),
      lastHeartbeatAt: (r.last_heartbeat_at as Date).toISOString(),
    })),
    stages: stages.rows.map((r) => ({ stage: r.stage as string, players: Number(r.n) })),
    currentSessionLengths: labels.map((label, i) => ({ bucket: label, sessions: durBy.get(i) ?? 0 })),
    regions: regions.rows.map((r) => ({ country: r.country as string, players: Number(r.n) })),
    joinsLeaves: minutes,
    ccuLastHour: ccu60,
    ccu24h: ccu24,
  };
}
