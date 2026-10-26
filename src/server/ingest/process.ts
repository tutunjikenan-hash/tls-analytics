import type { PoolClient } from "pg";
import type { Envelope, IngestEvent } from "./schema";

/**
 * Turns deduplicated events into the analytical tables. Every statement is an idempotent upsert
 * written so that events arriving late or out of order still give the same final state:
 *   - start times only ever move earlier (LEAST), last-seen times only later (GREATEST);
 *   - a session closed by the timeout reaper is reopened if a later heartbeat proves it was alive;
 *   - a session whose start event was lost is created from its first heartbeat (inferred_start).
 */

export type KeyedEvent = IngestEvent & { pk?: string; at: Date };

const TELEPORT_LINK_SECONDS = 180;

export async function processEvents(
  c: PoolClient,
  env: string,
  envelope: Envelope,
  events: KeyedEvent[],
  creatorShare: number,
): Promise<void> {
  if (events.length === 0) return;
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const minAt = sorted[0].at;
  const lastAlive = [...sorted].reverse().find((e) => e.type !== "server_stop")?.at ?? sorted[sorted.length - 1].at;

  // the server row: created on first sight, kept alive by any event
  await c.query(
    `INSERT INTO servers (env, server_id, place_id, place_version, server_kind, started_at, last_heartbeat_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (env, server_id) DO UPDATE SET
       started_at = LEAST(servers.started_at, EXCLUDED.started_at),
       last_heartbeat_at = GREATEST(servers.last_heartbeat_at, EXCLUDED.last_heartbeat_at),
       place_id = COALESCE(EXCLUDED.place_id, servers.place_id),
       place_version = COALESCE(EXCLUDED.place_version, servers.place_version),
       server_kind = COALESCE(EXCLUDED.server_kind, servers.server_kind),
       -- a server that reports in after it was closed (lost, or a reused id) is alive again;
       -- late events from before the close (timestamps <= ended_at) do not reopen it
       ended_at = CASE WHEN EXCLUDED.last_heartbeat_at > servers.ended_at THEN NULL ELSE servers.ended_at END,
       end_reason = CASE WHEN EXCLUDED.last_heartbeat_at > servers.ended_at THEN NULL ELSE servers.end_reason END`,
    [env, envelope.serverId, envelope.placeId || null, envelope.placeVersion ?? null, envelope.serverKind ?? null, minAt, lastAlive],
  );

  for (const e of sorted) {
    switch (e.type) {
      case "server_start":
        await c.query(`UPDATE servers SET started_at = LEAST(started_at, $3) WHERE env = $1 AND server_id = $2`, [env, envelope.serverId, e.at]);
        break;

      case "server_heartbeat":
        await heartbeat(c, env, envelope.serverId, e);
        break;

      case "server_stop":
        await c.query(
          `UPDATE servers SET ended_at = GREATEST($3, started_at), end_reason = 'shutdown', last_heartbeat_at = GREATEST(last_heartbeat_at, $3), player_count = 0
           WHERE env = $1 AND server_id = $2`,
          [env, envelope.serverId, e.at],
        );
        // anyone still open on this server left with it (their own session_end normally arrives too)
        await c.query(
          `UPDATE sessions SET ended_at = GREATEST($3, started_at), end_reason = 'server_shutdown', last_seen_at = GREATEST(last_seen_at, $3)
           WHERE env = $1 AND server_id = $2 AND (ended_at IS NULL OR end_reason = 'timeout')`,
          [env, envelope.serverId, e.at],
        );
        break;

      case "session_start":
        await sessionStart(c, env, envelope.serverId, e as Extract<KeyedEvent, { type: "session_start" }>);
        break;

      case "session_end":
        await sessionEnd(c, env, envelope.serverId, e as Extract<KeyedEvent, { type: "session_end" }>);
        break;

      case "purchase": {
        const d = e.d;
        const purchaseId = d.kind === "game_pass" ? `gp:${e.pk}:${d.productId}` : d.purchaseId;
        const est = Math.floor(d.robux * creatorShare);
        await c.query(
          `INSERT INTO purchases (env, purchase_id, kind, product_id, product_name, player_key, session_id, server_id,
                                  robux_gross, price_source, status, purchased_at, estimated_creator_robux)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (env, purchase_id) DO UPDATE SET
             status = CASE WHEN purchases.status = 'pending_verification' AND EXCLUDED.status = 'confirmed' THEN 'confirmed' ELSE purchases.status END,
             product_name = COALESCE(purchases.product_name, EXCLUDED.product_name),
             -- a price lookup that failed the first time (0) is filled in by a later report
             robux_gross = CASE WHEN purchases.robux_gross = 0 THEN EXCLUDED.robux_gross ELSE purchases.robux_gross END,
             estimated_creator_robux = CASE WHEN purchases.robux_gross = 0 THEN EXCLUDED.estimated_creator_robux ELSE purchases.estimated_creator_robux END`,
          [env, purchaseId, d.kind, d.productId, d.productName ?? null, e.pk, e.sid ?? null, envelope.serverId, d.robux, d.priceSource, d.status, e.at, est],
        );
        break;
      }

      case "game":
        await gameEvent(c, env, envelope.serverId, e as Extract<KeyedEvent, { type: "game" }>);
        break;

      case "counter":
        await c.query(
          `INSERT INTO server_counters (env, name, minute, value) VALUES ($1,$2,date_trunc('minute',$3::timestamptz),$4)
           ON CONFLICT (env, name, minute) DO UPDATE SET value = server_counters.value + EXCLUDED.value`,
          [env, e.d.name, e.at, e.d.value],
        );
        break;
    }
  }
}

async function upsertPlayer(c: PoolClient, env: string, pk: string, at: Date, country?: string | null) {
  await c.query(
    `INSERT INTO players (env, player_key, first_seen_at, last_seen_at, country) VALUES ($1,$2,$3,$3,$4)
     ON CONFLICT (env, player_key) DO UPDATE SET
       first_seen_at = LEAST(players.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at = GREATEST(players.last_seen_at, EXCLUDED.last_seen_at),
       country = COALESCE(EXCLUDED.country, players.country)`,
    [env, pk, at, country ?? null],
  );
}

async function heartbeat(c: PoolClient, env: string, serverId: string, e: Extract<KeyedEvent, { type: "server_heartbeat" }> & { pks?: string[] }) {
  const d = e.d;
  await c.query(
    `UPDATE servers SET player_count = $3, fps = $4, memory_mb = $5, uptime_sec = $6, stats_at = $7
     WHERE env = $1 AND server_id = $2 AND (stats_at IS NULL OR stats_at <= $7)`,
    [env, serverId, d.players.length, d.fps ?? null, d.memMb ?? null, d.uptimeSec ?? null, e.at],
  );
  await c.query(
    `INSERT INTO server_heartbeats (env, server_id, at, player_count, fps, memory_mb) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT DO NOTHING`,
    [env, serverId, e.at, d.players.length, d.fps ?? null, d.memMb ?? null],
  );
  const pks = (e as { pks?: string[] }).pks ?? [];
  for (let i = 0; i < d.players.length; i++) {
    const p = d.players[i];
    const pk = pks[i];
    await upsertPlayer(c, env, pk, e.at);
    await c.query(
      `INSERT INTO sessions (session_id, env, player_key, server_id, visit_id, started_at, last_seen_at, inferred_start, stage)
       VALUES ($1,$2,$3,$4,$1,$5,$5,true,$6)
       ON CONFLICT (session_id) DO UPDATE SET
         last_seen_at = GREATEST(sessions.last_seen_at, EXCLUDED.last_seen_at),
         stage = CASE WHEN EXCLUDED.last_seen_at >= sessions.last_seen_at THEN COALESCE(EXCLUDED.stage, sessions.stage) ELSE sessions.stage END,
         ended_at = CASE WHEN sessions.end_reason = 'timeout' AND EXCLUDED.last_seen_at > sessions.ended_at THEN NULL ELSE sessions.ended_at END,
         end_reason = CASE WHEN sessions.end_reason = 'timeout' AND EXCLUDED.last_seen_at > sessions.ended_at THEN NULL ELSE sessions.end_reason END`,
      [p.sid, env, pk, serverId, e.at, p.stage ?? null],
    );
  }
}

async function sessionStart(c: PoolClient, env: string, serverId: string, e: Extract<KeyedEvent, { type: "session_start" }>) {
  const pk = e.pk as string;
  const teleportIn = e.d?.teleportIn === true;
  await upsertPlayer(c, env, pk, e.at, e.d?.country ?? null);
  let visitId: string = e.sid;
  if (teleportIn) {
    // continue the visit of the session this player teleported from (ended or still open, within 3 minutes)
    const { rows } = await c.query<{ visit_id: string }>(
      `SELECT visit_id FROM sessions
       WHERE env = $1 AND player_key = $2 AND session_id <> $3 AND started_at <= $4
         AND COALESCE(ended_at, last_seen_at) >= $4::timestamptz - make_interval(secs => $5)
       ORDER BY started_at DESC LIMIT 1`,
      [env, pk, e.sid, e.at, TELEPORT_LINK_SECONDS],
    );
    if (rows[0]) visitId = rows[0].visit_id;
  }
  await c.query(
    `INSERT INTO sessions (session_id, env, player_key, server_id, visit_id, started_at, last_seen_at, teleport_in, country, referred)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)
     ON CONFLICT (session_id) DO UPDATE SET
       started_at = LEAST(sessions.started_at, EXCLUDED.started_at),
       visit_id = CASE WHEN sessions.inferred_start THEN EXCLUDED.visit_id ELSE sessions.visit_id END,
       inferred_start = false,
       teleport_in = EXCLUDED.teleport_in,
       referred = EXCLUDED.referred,
       country = COALESCE(EXCLUDED.country, sessions.country)`,
    [e.sid, env, pk, serverId, visitId, e.at, teleportIn, e.d?.country ?? null, e.d?.referred === true],
  );
}

async function sessionEnd(c: PoolClient, env: string, serverId: string, e: Extract<KeyedEvent, { type: "session_end" }>) {
  const pk = e.pk as string;
  const reason = e.d?.reason ?? "left";
  const dur = e.d?.durationSec;
  const startGuess = dur !== undefined ? new Date(e.at.getTime() - dur * 1000) : e.at;
  await upsertPlayer(c, env, pk, startGuess);
  await c.query(
    `INSERT INTO sessions (session_id, env, player_key, server_id, visit_id, started_at, last_seen_at, ended_at, end_reason, inferred_start)
     VALUES ($1,$2,$3,$4,$1,$5,$6,$6,$7,true)
     ON CONFLICT (session_id) DO UPDATE SET
       started_at = CASE WHEN sessions.inferred_start THEN LEAST(sessions.started_at, EXCLUDED.started_at) ELSE sessions.started_at END,
       ended_at = GREATEST(EXCLUDED.ended_at, CASE WHEN sessions.inferred_start THEN LEAST(sessions.started_at, EXCLUDED.started_at) ELSE sessions.started_at END),
       end_reason = EXCLUDED.end_reason,
       last_seen_at = GREATEST(sessions.last_seen_at, EXCLUDED.ended_at)`,
    [e.sid, env, pk, serverId, startGuess, e.at, reason],
  );
}

const RUN_END: Record<string, "completed" | "failed" | "abandoned"> = {
  run_complete: "completed",
  run_fail: "failed",
  run_abandon: "abandoned",
};

async function gameEvent(c: PoolClient, env: string, serverId: string, e: Extract<KeyedEvent, { type: "game" }>) {
  const d = e.d;
  const pk = e.pk ?? null;
  await c.query(
    `INSERT INTO gameplay_events (event_id, env, name, player_key, session_id, server_id, run_id, chapter, stage, area, value, props, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
    [e.id, env, d.name, pk, e.sid ?? null, serverId, d.runId ?? null, d.chapter ?? null, d.stage ?? null, d.area ?? null, d.value ?? null, d.props ?? {}, e.at],
  );
  if (!pk || !d.runId) return;
  if (d.name === "run_start") {
    await c.query(
      `INSERT INTO runs (env, run_id, player_key, chapter, stage, started_at, attempt)
       VALUES ($1,$2,$3,$4,$5,$6,
         1 + (SELECT count(*) FROM runs r WHERE r.env = $1 AND r.player_key = $3 AND r.chapter IS NOT DISTINCT FROM $4
              AND r.stage IS NOT DISTINCT FROM $5 AND r.started_at < $6))
       ON CONFLICT (env, run_id, player_key) DO UPDATE SET started_at = LEAST(runs.started_at, EXCLUDED.started_at)`,
      [env, d.runId, pk, d.chapter ?? null, d.stage ?? null, e.at],
    );
  } else if (RUN_END[d.name]) {
    const reason = typeof d.props?.reason === "string" ? d.props.reason : null;
    await c.query(
      `INSERT INTO runs (env, run_id, player_key, chapter, stage, started_at, ended_at, outcome, fail_reason, attempt)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,
         1 + (SELECT count(*) FROM runs r WHERE r.env = $1 AND r.player_key = $3 AND r.chapter IS NOT DISTINCT FROM $4
              AND r.stage IS NOT DISTINCT FROM $5 AND r.started_at < $6))
       ON CONFLICT (env, run_id, player_key) DO UPDATE SET
         ended_at = GREATEST(EXCLUDED.ended_at, runs.started_at),
         outcome = EXCLUDED.outcome,
         fail_reason = COALESCE(EXCLUDED.fail_reason, runs.fail_reason),
         stage = COALESCE(EXCLUDED.stage, runs.stage),
         chapter = COALESCE(runs.chapter, EXCLUDED.chapter)`,
      [env, d.runId, pk, d.chapter ?? null, d.stage ?? null, e.at, RUN_END[d.name], reason],
    );
  }
}
