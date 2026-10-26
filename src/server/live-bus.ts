import { pool } from "./db";
import { getSettings } from "./settings";
import * as core from "./metrics/core";

/**
 * Live stream source for Server-Sent Events. Every app instance runs one shared poller (only while at
 * least one dashboard is connected) that reads the live snapshot from Postgres every 5 s and fans it
 * out to that instance's subscribers. Reading from the database (not from the job leader's memory)
 * keeps this correct with any number of instances.
 */

export interface LiveSnapshot {
  env: string;
  at: string;
  ccu: number;
  servers: number;
  sessions: number;
  joinsLastMin: number;
  leavesLastMin: number;
  robuxLastHour: number;
  lastEventAt: string | null;
}

type Listener = (s: LiveSnapshot) => void;

const subscribers = new Map<string, Set<Listener>>(); // env -> listeners
let timer: NodeJS.Timeout | null = null;
const last = new Map<string, LiveSnapshot>();

export async function snapshot(env: string, now = new Date()): Promise<LiveSnapshot> {
  const s = await getSettings();
  const db = pool();
  const [c, flow] = await Promise.all([
    core.ccuNow(db, env, s.session_timeout_seconds, now),
    db.query(
      `SELECT (SELECT count(*) FROM sessions WHERE env = $1 AND started_at >= $2::timestamptz - interval '1 minute') AS joins,
              (SELECT count(*) FROM sessions WHERE env = $1 AND ended_at >= $2::timestamptz - interval '1 minute') AS leaves,
              (SELECT COALESCE(sum(robux_gross),0) FROM purchases WHERE env = $1 AND status = 'confirmed' AND refunded_at IS NULL
                 AND purchased_at >= $2::timestamptz - interval '1 hour') AS robux,
              (SELECT max(received_at) FROM raw_events WHERE env = $1 AND received_at >= $2::timestamptz - interval '1 day') AS last_event`,
      [env, now],
    ),
  ]);
  const f = flow.rows[0];
  return {
    env, at: now.toISOString(), ccu: c.ccu, servers: c.servers, sessions: c.sessions,
    joinsLastMin: Number(f.joins), leavesLastMin: Number(f.leaves), robuxLastHour: Number(f.robux),
    lastEventAt: f.last_event ? (f.last_event as Date).toISOString() : null,
  };
}

async function poll() {
  for (const [env, set] of subscribers) {
    if (set.size === 0) continue;
    try {
      const snap = await snapshot(env);
      last.set(env, snap);
      for (const l of set) l(snap);
    } catch (err) {
      console.error("[live] snapshot failed", (err as Error).message);
    }
  }
}

export function subscribe(env: string, l: Listener): () => void {
  const set = subscribers.get(env) ?? new Set<Listener>();
  set.add(l);
  subscribers.set(env, set);
  const cached = last.get(env);
  if (cached && Date.now() - Date.parse(cached.at) < 10_000) l(cached);
  else void snapshot(env).then((s) => { last.set(env, s); l(s); }).catch(() => undefined);
  if (!timer) timer = setInterval(() => void poll(), 5_000);
  return () => {
    set.delete(l);
    const total = [...subscribers.values()].reduce((a, s) => a + s.size, 0);
    if (total === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
