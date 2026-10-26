import type { Queryable } from "../db";
import { getSettings } from "../settings";
import { context, describeRange, freshness } from "./overview";
import type { RangeQuery } from "./range";

/** Server health: live servers, lifetimes, crashes (lost heartbeats), performance and ingestion. */
export async function serversPage(db: Queryable, q: RangeQuery, now = new Date()) {
  const { trackingStart, range: r } = await context(db, q, now);
  const env = q.env;
  const s = await getSettings(db);
  const perfFrom = new Date(Math.max(r.from.getTime(), r.to.getTime() - 24 * 3600_000)); // heartbeats: at most 24 h shown
  const bucket = r.to.getTime() - perfFrom.getTime() > 6 * 3600_000 ? 15 : 1;

  const [summary, versions, perf, ingest, ingestTotals, recentLost, kinds] = await Promise.all([
    db.query(
      `SELECT count(*) AS started,
              count(*) FILTER (WHERE end_reason = 'shutdown') AS shutdown,
              count(*) FILTER (WHERE end_reason = 'lost') AS lost,
              count(*) FILTER (WHERE ended_at IS NULL) AS running,
              avg(EXTRACT(EPOCH FROM ended_at - started_at)) FILTER (WHERE ended_at IS NOT NULL) AS avg_life
       FROM servers WHERE env = $1 AND started_at >= $2 AND started_at < $3`,
      [env, r.from, r.to],
    ),
    db.query(
      `SELECT COALESCE(place_version::text, '?') AS v, count(*) AS n FROM servers
       WHERE env = $1 AND ended_at IS NULL AND last_heartbeat_at >= $2::timestamptz - make_interval(secs => $3) GROUP BY 1 ORDER BY 1 DESC`,
      [env, now, s.session_timeout_seconds],
    ),
    db.query(
      `SELECT to_timestamp(floor(EXTRACT(EPOCH FROM at) / ($4*60)) * ($4*60)) AS t, avg(fps) AS fps, min(fps) AS min_fps,
              avg(memory_mb) AS mem, max(memory_mb) AS max_mem, avg(player_count) AS players
       FROM server_heartbeats WHERE env = $1 AND at >= $2 AND at < $3 GROUP BY 1 ORDER BY 1`,
      [env, perfFrom, r.to, bucket],
    ),
    db.query(
      `SELECT date_trunc('minute', received_at) AS t, count(*) AS requests, sum(accepted) AS accepted, sum(duplicates) AS duplicates, sum(rejected) AS rejected
       FROM ingest_requests WHERE received_at >= $1::timestamptz - interval '60 minutes' GROUP BY 1 ORDER BY 1`,
      [now],
    ),
    db.query(
      `SELECT count(*) AS requests, COALESCE(sum(accepted),0) AS accepted, COALESCE(sum(duplicates),0) AS duplicates, COALESCE(sum(rejected),0) AS rejected
       FROM ingest_requests WHERE received_at >= $1 AND received_at < $2`,
      [r.from, r.to],
    ),
    db.query(
      `SELECT server_id, place_version, started_at, ended_at FROM servers WHERE env = $1 AND end_reason = 'lost' ORDER BY ended_at DESC LIMIT 15`,
      [env],
    ),
    db.query(`SELECT COALESCE(server_kind,'?') AS k, count(*) AS n FROM servers WHERE env = $1 AND started_at >= $2 AND started_at < $3 GROUP BY 1`, [env, r.from, r.to]),
  ]);
  const x = summary.rows[0];
  return {
    range: describeRange(r),
    env,
    generatedAt: now.toISOString(),
    hasData: trackingStart !== null,
    freshness: await freshness(db, env),
    started: Number(x.started),
    shutdown: Number(x.shutdown),
    lost: Number(x.lost),
    running: Number(x.running),
    lostPct: Number(x.started) > 0 ? (Number(x.lost) / Number(x.started)) * 100 : null,
    avgLifetimeSec: x.avg_life === null ? null : Number(x.avg_life),
    kinds: kinds.rows.map((k) => ({ kind: k.k as string, servers: Number(k.n) })),
    liveVersions: versions.rows.map((v) => ({ placeVersion: v.v as string, servers: Number(v.n) })),
    performance: {
      bucketMin: bucket,
      points: perf.rows.map((p) => ({
        t: (p.t as Date).toISOString(), fps: p.fps === null ? null : Number(p.fps), minFps: p.min_fps === null ? null : Number(p.min_fps),
        memoryMb: p.mem === null ? null : Number(p.mem), maxMemoryMb: p.max_mem === null ? null : Number(p.max_mem), players: Number(p.players),
      })),
    },
    ingestion: {
      lastHour: ingest.rows.map((i) => ({ t: (i.t as Date).toISOString(), requests: Number(i.requests), accepted: Number(i.accepted), duplicates: Number(i.duplicates), rejected: Number(i.rejected) })),
      totals: Object.fromEntries(Object.entries(ingestTotals.rows[0]).map(([k, v]) => [k, Number(v)])),
    },
    recentLost: recentLost.rows.map((l) => ({ serverId: l.server_id as string, placeVersion: l.place_version as number | null, startedAt: (l.started_at as Date).toISOString(), lostAt: (l.ended_at as Date).toISOString() })),
  };
}
