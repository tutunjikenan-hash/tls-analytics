import { Client } from "pg";
import { pool } from "../db";
import { env } from "../env";
import { getSettings } from "../settings";
import { evaluateAlerts } from "./alerts";
import { fetchRobloxReported, prune } from "./maintenance";
import { reap, relinkTeleports, sampleCcu } from "./live";
import { maybeSendReports } from "./reports";
import { addDays, localDay, rebuildPlayerDays, rollupDays, rollupHours, rollupPlayerDays, rollupRetention } from "./rollups";

/**
 * Background jobs. Exactly one app instance runs them: the leader holds a Postgres advisory lock on a
 * dedicated connection; if that connection drops, another instance takes over within ~15 s.
 *
 *   live        every 15 s  close lost servers/sessions, sample CCU, push the live snapshot (SSE)
 *   rollups     every 30 s  recompute aggregates for every time range touched by new events
 *   wide        every 10 m  recompute the last 48 h / 3 days (absorbs stragglers and reaper closures)
 *   retention   every 60 m  (and at day change) calendar-day retention cells
 *   alerts      every 60 s
 *   reports     every 5 m   daily / weekly Discord report when due
 *   roblox      every 10 m  public Roblox-reported stats
 *   prune       every 60 m  data retention
 */

const LOCK_KEY = 74_201_337; // advisory lock id for the job leader
const ALERT_ENVS = (process.env.ALERT_ENVS ?? "production").split(",").map((s) => s.trim()).filter(Boolean);

let started = false;
let leaderClient: Client | null = null;
let timers: NodeJS.Timeout[] = [];
const running = new Set<string>();

async function record(name: string, fn: () => Promise<unknown>) {
  if (running.has(name)) return; // previous run still going: skip, never overlap
  running.add(name);
  const t0 = Date.now();
  try {
    const info = await fn();
    await pool().query(
      `INSERT INTO job_state (name, last_run_at, last_ok_at, last_error, info) VALUES ($1, now(), now(), NULL, $2)
       ON CONFLICT (name) DO UPDATE SET last_run_at = now(), last_ok_at = now(), last_error = NULL, info = $2`,
      [name, JSON.stringify({ ms: Date.now() - t0, result: info ?? null })],
    );
  } catch (err) {
    console.error(`[jobs] ${name} failed:`, (err as Error).message);
    await pool()
      .query(
        `INSERT INTO job_state (name, last_run_at, last_error) VALUES ($1, now(), $2)
         ON CONFLICT (name) DO UPDATE SET last_run_at = now(), last_error = $2`,
        [name, (err as Error).message.slice(0, 500)],
      )
      .catch(() => undefined);
  } finally {
    running.delete(name);
  }
}

async function jobState(name: string): Promise<Record<string, unknown>> {
  const { rows } = await pool().query(`SELECT info FROM job_state WHERE name = $1`, [name]);
  return (rows[0]?.info as Record<string, unknown>) ?? {};
}

/** live: reconciliation + CCU sample + SSE push */
export async function liveTick(now = new Date()) {
  const s = await getSettings();
  const r = await reap(pool(), s.session_timeout_seconds, now);
  const ccu = await sampleCcu(pool(), s.session_timeout_seconds, now);
  return { reaped: r, ccu };
}

/**
 * rollups: find the earliest event time among events received since the last run ("dirty since"),
 * and recompute every hour/day from there. Late or replayed events therefore always land in the
 * right bucket, and recomputation keeps the aggregates exact.
 */
export async function rollupTick(now = new Date()) {
  const s = await getSettings();
  const tz = s.reporting_timezone;
  const state = await jobState("rollups");
  const prevCursor = (state.result as { cursor?: string } | null | undefined)?.cursor;
  const lastReceived = typeof prevCursor === "string" ? new Date(prevCursor) : new Date(now.getTime() - 3600_000);
  const { rows } = await pool().query<{ mi: Date | null; mr: Date | null }>(
    `SELECT min(occurred_at) AS mi, max(received_at) AS mr FROM raw_events WHERE received_at > $1`,
    [lastReceived],
  );
  // the reaper closes sessions up to (timeout + 15 s) in the past, and CCU minutes are written "now"
  const floor = new Date(now.getTime() - (s.session_timeout_seconds + 120) * 1000);
  const relinked = await relinkTeleports(pool(), now);
  let since = rows[0].mi && rows[0].mi < floor ? rows[0].mi : floor;
  if (relinked && relinked < since) since = relinked;
  await rollupPlayerDays(pool(), tz, since);
  await rollupHours(pool(), since, now);
  await rollupDays(pool(), tz, localDay(since, tz), localDay(now, tz));
  // received_at is the ingest transaction's start time, and a transaction can commit up to the 30 s
  // statement timeout later — so the cursor trails "now" by 60 s (re-processing an overlap is harmless)
  const lagged = new Date(now.getTime() - 60_000);
  const top = rows[0].mr && rows[0].mr < lagged ? rows[0].mr : lagged;
  const cursor = (top > lastReceived ? top : lastReceived).toISOString();
  // record() stores this as job_state.info.result, where the next run reads the cursor
  return { cursor, since: since.toISOString() };
}

export async function wideTick(now = new Date()) {
  const tz = (await getSettings()).reporting_timezone;
  const since = new Date(now.getTime() - 48 * 3600_000);
  await rollupPlayerDays(pool(), tz, since);
  await rollupHours(pool(), since, now);
  await rollupDays(pool(), tz, addDays(localDay(now, tz), -3), localDay(now, tz));
  return { since: since.toISOString() };
}

export async function retentionTick(now = new Date()) {
  const tz = (await getSettings()).reporting_timezone;
  const n = await rollupRetention(pool(), tz, localDay(now, tz));
  return { cells: n };
}

/**
 * Recomputes every aggregate from the base tables in one transaction (readers never see a half-empty
 * state). Requested after a reporting time zone change, a creator-share change or a reconciliation.
 */
export async function rebuildAll(now = new Date()) {
  const tz = (await getSettings(undefined, true)).reporting_timezone;
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL statement_timeout = 0");
    const { rows } = await c.query<{ first: Date | null }>(`SELECT min(started_at) AS first FROM sessions`);
    await rebuildPlayerDays(c, tz);
    await c.query(`DELETE FROM daily_stats`);
    await c.query(`DELETE FROM retention_cohorts`);
    if (rows[0].first) {
      await rollupHours(c, rows[0].first, now);
      await rollupDays(c, tz, localDay(rows[0].first, tz), localDay(now, tz));
      await rollupRetention(c, tz, localDay(now, tz), 30, 3650);
    }
    await c.query(`DELETE FROM job_state WHERE name = 'rebuild_requested'`);
    await c.query("COMMIT");
    return { tz, from: rows[0].first };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

async function checkRebuild() {
  const { rows } = await pool().query(`SELECT 1 FROM job_state WHERE name = 'rebuild_requested'`);
  if (rows.length) await record("rebuild", () => rebuildAll());
}

let lastRetentionDay = "";

function schedule(name: string, everyMs: number, fn: () => Promise<unknown>, initialDelayMs = 1000) {
  const run = () => {
    if (!leaderClient) return;
    void record(name, fn);
  };
  timers.push(setTimeout(run, initialDelayMs));
  timers.push(setInterval(run, everyMs));
}

async function tryBecomeLeader() {
  if (leaderClient) return;
  const e = env();
  const c = new Client({
    connectionString: e.DATABASE_URL,
    ssl: e.DATABASE_SSL === "disable" ? undefined : e.DATABASE_SSL === "no-verify" ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
  });
  try {
    await c.connect();
    const { rows } = await c.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY]);
    if (!rows[0].ok) {
      await c.end();
      return;
    }
    c.on("error", (err) => {
      console.error("[jobs] leader connection lost:", err.message);
      leaderClient = null;
    });
    c.on("end", () => {
      leaderClient = null;
    });
    leaderClient = c;
    console.log("[jobs] this instance is the job leader");
  } catch (err) {
    console.error("[jobs] leader election failed:", (err as Error).message);
    await c.end().catch(() => undefined);
  }
}

export function startJobs() {
  if (started) return;
  started = true;
  if (!env().JOBS_ENABLED) {
    console.log("[jobs] JOBS_ENABLED=false — background jobs are off on this instance");
    return;
  }
  void tryBecomeLeader();
  timers.push(setInterval(() => void tryBecomeLeader(), 15_000));

  schedule("live", 15_000, () => liveTick(), 2_000);
  schedule("rollups", 30_000, () => rollupTick(), 5_000);
  schedule("wide", 10 * 60_000, () => wideTick(), 60_000);
  schedule("retention", 60 * 60_000, () => retentionTick(), 90_000);
  // day change: retention for the day that just ended, without waiting up to an hour
  schedule("daywatch", 60_000, async () => {
    const tz = (await getSettings()).reporting_timezone;
    const today = localDay(new Date(), tz);
    if (lastRetentionDay && today !== lastRetentionDay) await record("retention", () => retentionTick());
    lastRetentionDay = today;
    await checkRebuild();
    return { today };
  }, 10_000);
  schedule("alerts", 60_000, () => evaluateAlerts(pool(), ALERT_ENVS).then((f) => ({ fired: f.length })), 120_000);
  schedule("reports", 5 * 60_000, () => maybeSendReports(pool()), 180_000);
  schedule("roblox", 10 * 60_000, () => fetchRobloxReported(pool()), 30_000);
  schedule("prune", 60 * 60_000, () => prune(pool()), 300_000);
}

export async function stopJobs() {
  for (const t of timers) clearInterval(t);
  timers = [];
  started = false;
  if (leaderClient) await leaderClient.end().catch(() => undefined);
  leaderClient = null;
}
