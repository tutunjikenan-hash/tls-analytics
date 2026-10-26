import type { Queryable } from "../db";
import { env } from "../env";
import { COLORS, postDiscord } from "./discord";

/**
 * Alert rules (table alert_rules, editable in Settings → Alerts). Each evaluator looks only at measured
 * data; a rule never fires on an environment that has no data, and every rule has a cooldown so a
 * sustained condition notifies once, not every minute.
 */

type Severity = "info" | "warning" | "critical";
export interface Firing {
  kind: string;
  title: string;
  details: Record<string, unknown>;
}

interface Rule {
  kind: string;
  enabled: boolean;
  params: Record<string, number>;
  cooldown_min: number;
  severity: Severity;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

type Evaluator = (db: Queryable, envName: string, p: Record<string, number>, now: Date) => Promise<Firing | null>;

const EVALUATORS: Record<string, Evaluator> = {
  async ccu_spike(db, e, p, now) {
    const b = await ccuBaseline(db, e, p.window_min ?? 10, now);
    if (!b || b.current === null || b.baseline === null) return null;
    if (Math.max(b.current, b.baseline) < (p.min_ccu ?? 10)) return null;
    if (b.current < b.baseline * (1 + (p.pct ?? 50) / 100)) return null;
    return { kind: "ccu_spike", title: `CCU spike: ${b.current} players (was ~${Math.round(b.baseline)})`, details: b };
  },
  async ccu_drop(db, e, p, now) {
    const b = await ccuBaseline(db, e, p.window_min ?? 10, now);
    if (!b || b.current === null || b.baseline === null) return null;
    if (b.baseline < (p.min_ccu ?? 10)) return null;
    if (b.current > b.baseline * (1 - (p.pct ?? 40) / 100)) return null;
    return { kind: "ccu_drop", title: `CCU drop: ${b.current} players (was ~${Math.round(b.baseline)})`, details: b };
  },
  async departure_surge(db, e, p, now) {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE ended_at >= $2::timestamptz - interval '5 minutes') AS recent,
              count(*) FILTER (WHERE ended_at < $2::timestamptz - interval '5 minutes') AS before
       FROM sessions WHERE env = $1 AND ended_at >= $2::timestamptz - interval '65 minutes' AND ended_at < $2 AND end_reason = 'left'`,
      [e, now],
    );
    const recent = Number(rows[0].recent);
    const perFive = Number(rows[0].before) / 12;
    if (recent < (p.min_leaves ?? 10) || recent < Math.max(1, perFive) * (p.multiplier ?? 3)) return null;
    return { kind: "departure_surge", title: `${recent} players left in 5 minutes (usual ~${perFive.toFixed(1)})`, details: { recent, usualPer5Min: perFive } };
  },
  async revenue_spike(db, e, p, now) {
    const { rows } = await db.query(
      `SELECT COALESCE(sum(robux_gross) FILTER (WHERE purchased_at >= $2::timestamptz - interval '1 hour'), 0) AS last_hour,
              COALESCE(sum(robux_gross) FILTER (WHERE purchased_at < $2::timestamptz - interval '1 hour'), 0) / (7 * 24.0) AS hourly_avg,
              min(purchased_at) AS first
       FROM purchases WHERE env = $1 AND status = 'confirmed' AND refunded_at IS NULL AND purchased_at >= $2::timestamptz - interval '169 hours'`,
      [e, now],
    );
    const last = Number(rows[0].last_hour);
    const avg = Number(rows[0].hourly_avg);
    if (last < (p.min_robux ?? 500) || last < Math.max(1, avg) * (p.multiplier ?? 3)) return null;
    return { kind: "revenue_spike", title: `Revenue spike: R$${last} in the last hour (7-day hourly average R$${avg.toFixed(0)})`, details: { lastHour: last, hourlyAvg: avg } };
  },
  async purchase_errors(db, e, p, now) {
    const { rows } = await db.query(
      `SELECT COALESCE(sum(value),0) AS n FROM server_counters WHERE env = $1 AND name = 'receipt_error'
         AND minute >= $2::timestamptz - interval '15 minutes'`,
      [e, now],
    );
    const n = Number(rows[0].n);
    if (n < (p.min_errors ?? 1)) return null;
    return { kind: "purchase_errors", title: `${n} purchase receipt error(s) in the last 15 minutes`, details: { errors: n } };
  },
  async server_failures(db, e, p, now) {
    const { rows } = await db.query(
      `SELECT count(*) AS n FROM servers WHERE env = $1 AND end_reason = 'lost' AND ended_at >= $2::timestamptz - make_interval(mins => $3)`,
      [e, now, p.window_min ?? 15],
    );
    const n = Number(rows[0].n);
    if (n < (p.min_lost ?? 2)) return null;
    return { kind: "server_failures", title: `${n} game servers stopped responding in ${p.window_min ?? 15} minutes`, details: { lost: n } };
  },
  async ingestion_outage(db, e, p, now) {
    const { rows } = await db.query<{ last: Date | null; live_recently: boolean }>(
      `SELECT (SELECT max(received_at) FROM raw_events WHERE env = $1) AS last,
              EXISTS (SELECT 1 FROM servers WHERE env = $1 AND last_heartbeat_at >= $2::timestamptz - interval '6 hours') AS live_recently`,
      [e, now],
    );
    const last = rows[0].last;
    if (!last || !rows[0].live_recently) return null; // never had data, or the game has simply been empty for hours
    const silentMin = (now.getTime() - last.getTime()) / 60_000;
    if (silentMin < (p.silent_min ?? 5)) return null;
    // silence is only suspicious if servers were running (an empty game legitimately sends nothing)
    // (servers that went quiet are either still "open" or were just closed as "lost" by the reaper)
    const { rows: open } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM servers WHERE env = $1 AND (ended_at IS NULL OR end_reason = 'lost')
         AND last_heartbeat_at >= $2::timestamptz - make_interval(mins => $3)`,
      [e, now, (p.silent_min ?? 5) + 15],
    );
    if (Number(open[0].n) === 0) return null;
    return { kind: "ingestion_outage", title: `No analytics received for ${Math.floor(silentMin)} minutes while servers were running`, details: { lastEventAt: last.toISOString(), silentMin } };
  },
  async completion_rate_shift(db, e, p, now) {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE ended_at >= $2::timestamptz - interval '24 hours') AS n_recent,
              count(*) FILTER (WHERE ended_at >= $2::timestamptz - interval '24 hours' AND outcome = 'completed') AS c_recent,
              count(*) FILTER (WHERE ended_at < $2::timestamptz - interval '24 hours') AS n_base,
              count(*) FILTER (WHERE ended_at < $2::timestamptz - interval '24 hours' AND outcome = 'completed') AS c_base
       FROM runs WHERE env = $1 AND outcome IS NOT NULL AND ended_at >= $2::timestamptz - interval '8 days' AND ended_at < $2`,
      [e, now],
    );
    const r = rows[0];
    const min = p.min_runs ?? 20;
    if (Number(r.n_recent) < min || Number(r.n_base) < min) return null;
    const recent = (Number(r.c_recent) / Number(r.n_recent)) * 100;
    const base = (Number(r.c_base) / Number(r.n_base)) * 100;
    if (Math.abs(recent - base) < (p.pct_points ?? 15)) return null;
    return {
      kind: "completion_rate_shift",
      title: `Completion rate ${recent > base ? "rose" : "fell"} to ${recent.toFixed(0)}% (previous 7 days ${base.toFixed(0)}%)`,
      details: { recentPct: recent, baselinePct: base, recentRuns: Number(r.n_recent), baselineRuns: Number(r.n_base) },
    };
  },
};

async function ccuBaseline(db: Queryable, e: string, windowMin: number, now: Date) {
  const { rows } = await db.query(
    `SELECT (SELECT last_ccu FROM ccu_minutes WHERE env = $1 AND minute >= $2::timestamptz - interval '2 minutes' ORDER BY minute DESC LIMIT 1) AS current,
            (SELECT avg(peak_ccu) FROM ccu_minutes WHERE env = $1 AND minute >= $2::timestamptz - make_interval(mins => $3 + 2)
               AND minute < $2::timestamptz - interval '2 minutes') AS baseline,
            (SELECT count(*) FROM ccu_minutes WHERE env = $1 AND minute >= $2::timestamptz - make_interval(mins => $3 + 2)
               AND minute < $2::timestamptz - interval '2 minutes') AS samples`,
    [e, now, windowMin],
  );
  if (Number(rows[0].samples) < Math.max(3, windowMin / 2)) return null; // not enough history to compare against
  return { current: num(rows[0].current), baseline: num(rows[0].baseline), windowMin };
}

/** Evaluates every enabled rule for the given environments; records and notifies new firings. */
export async function evaluateAlerts(db: Queryable, envs: string[], now = new Date(), notify = true): Promise<Firing[]> {
  const { rows: rules } = await db.query<Rule>(`SELECT kind, enabled, params, cooldown_min, severity FROM alert_rules WHERE enabled`);
  const fired: Firing[] = [];
  for (const envName of envs) {
    for (const rule of rules) {
      const ev = EVALUATORS[rule.kind];
      if (!ev) continue;
      let f: Firing | null = null;
      try {
        f = await ev(db, envName, rule.params, now);
      } catch (err) {
        console.error(`[alerts] ${rule.kind} failed`, (err as Error).message);
        continue;
      }
      if (!f) continue;
      const recent = await db.query(
        `SELECT 1 FROM alert_events WHERE env = $1 AND kind = $2 AND fired_at >= $3::timestamptz - make_interval(mins => $4) LIMIT 1`,
        [envName, rule.kind, now, rule.cooldown_min],
      );
      if ((recent.rowCount ?? 0) > 0) continue;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO alert_events (env, kind, severity, title, details, fired_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [envName, rule.kind, rule.severity, f.title, f.details, now],
      );
      fired.push(f);
      if (notify && env().DISCORD_WEBHOOK_URL) {
        const error = await postDiscord([
          {
            title: `${rule.severity === "critical" ? "🔴" : rule.severity === "warning" ? "🟠" : "🔵"} ${f.title}`,
            description: envName === "production" ? undefined : `Environment: **${envName}**`,
            color: COLORS[rule.severity],
            footer: { text: `TLS Analytics · ${rule.kind}` },
            timestamp: now.toISOString(),
          },
        ]);
        await db.query(`UPDATE alert_events SET notified_at = CASE WHEN $2::text IS NULL THEN now() END, notify_error = $2 WHERE id = $1`, [rows[0].id, error]);
      }
    }
  }
  return fired;
}
