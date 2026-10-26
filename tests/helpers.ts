import { randomUUID } from "node:crypto";
import { pool } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { handleIngest } from "@/server/ingest/handler";
import { clearKeyCache, generateKey, resetRateLimits } from "@/server/ingest/keys";
import { invalidateSettings } from "@/server/settings";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/tls_test";
process.env.PLAYER_ID_PEPPER ??= "test-pepper-test-pepper-test-pepper-0123";
process.env.JOBS_ENABLED = "false";
resetEnvCache();

export const T0 = Date.UTC(2026, 9, 20, 12, 0, 0); // 2026-10-20 12:00:00Z

/** Empties every data table (keeps schema + seed rows). */
export async function resetDb() {
  await pool().query(`TRUNCATE raw_events, ingest_requests, servers, server_heartbeats, players, sessions, player_days, purchases,
    gameplay_events, runs, ccu_minutes, hourly_stats, daily_stats, retention_cohorts, alert_events, server_counters, roblox_reported,
    report_runs, ingest_keys CASCADE`);
  await pool().query(`UPDATE settings SET value = '"UTC"' WHERE key = 'reporting_timezone'`);
  await pool().query(`UPDATE settings SET value = 'null'::jsonb WHERE key = 'tracking_started_at'`);
  clearKeyCache();
  resetRateLimits();
  invalidateSettings();
}

export async function makeKey(envs: string[] = ["production", "studio"]): Promise<string> {
  const k = generateKey();
  await pool().query(`INSERT INTO ingest_keys (name, key_hash, key_prefix, environments) VALUES ('test', $1, $2, $3)`, [k.hash, k.prefix, envs]);
  return k.key;
}

export interface SendOpts {
  key: string;
  env?: string;
  serverId?: string;
  requestId?: string;
  now?: number;
  sentAt?: number;
}

export async function send(events: unknown[], o: SendOpts) {
  const now = o.now ?? T0;
  const body = {
    v: 1,
    env: o.env ?? "production",
    serverId: o.serverId ?? "server-a",
    placeId: 134111235673543, // The Last Shift's real place id (larger than 1e14)
    placeVersion: 7,
    serverKind: "public",
    sentAt: o.sentAt ?? now,
    events,
  };
  return handleIngest({ authorization: `Bearer ${o.key}`, requestId: o.requestId ?? randomUUID(), bodyText: JSON.stringify(body), now });
}

export const ev = {
  start: (sid: string, uid: number, ts: number, d: Record<string, unknown> = {}) => ({ id: randomUUID(), type: "session_start", ts, sid, uid, d }),
  end: (sid: string, uid: number, ts: number, d: Record<string, unknown> = {}) => ({ id: randomUUID(), type: "session_end", ts, sid, uid, d }),
  hb: (ts: number, players: Array<{ sid: string; uid: number; stage?: string }>) => ({ id: randomUUID(), type: "server_heartbeat", ts, d: { players } }),
  stop: (ts: number) => ({ id: randomUUID(), type: "server_stop", ts, d: { reason: "shutdown" } }),
  purchase: (uid: number, ts: number, d: Record<string, unknown>) => ({ id: randomUUID(), type: "purchase", ts, uid, d }),
  game: (uid: number, ts: number, d: Record<string, unknown>, sid?: string) => ({ id: randomUUID(), type: "game", ts, uid, sid, d }),
};

export const min = (n: number) => n * 60_000;
export const sec = (n: number) => n * 1000;
