import type { NextRequest } from "next/server";
import { audit } from "@/server/auth/auth";
import { pool } from "@/server/db";
import { clientIp, handler, HttpError, requireUser, searchParams } from "@/server/http";
import { resolveRange, rangeQuery } from "@/server/metrics/range";
import { envTrackingStart } from "@/server/metrics/series";
import { getSettings } from "@/server/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATASETS: Record<string, { perm: "export"; sql: string; byDay?: boolean }> = {
  daily: {
    perm: "export",
    byDay: true,
    sql: `SELECT day, visits, sessions, dau, new_players, returning_players, playtime_sec, round(avg_visit_sec) AS avg_visit_sec,
            round(median_visit_sec) AS median_visit_sec, revenue_robux, est_creator_robux, purchases, paying_users, peak_ccu, timezone
          FROM daily_stats WHERE env = $1 AND day BETWEEN $2::date AND $3::date ORDER BY day`,
  },
  hourly: {
    perm: "export",
    sql: `SELECT hour, visits, sessions, unique_players, new_players, playtime_sec, revenue_robux, purchases, peak_ccu, joins, leaves
          FROM hourly_stats WHERE env = $1 AND hour >= $2 AND hour < $3 ORDER BY hour`,
  },
  purchases: {
    perm: "export",
    sql: `SELECT purchase_id, purchased_at, kind, product_id, product_name, player_key, robux_gross, price_source, status,
            estimated_creator_robux, verified_creator_robux, reconciled_at, refunded_at
          FROM purchases WHERE env = $1 AND purchased_at >= $2 AND purchased_at < $3 ORDER BY purchased_at`,
  },
  runs: {
    perm: "export",
    sql: `SELECT run_id, player_key, chapter, stage, started_at, ended_at, outcome, fail_reason, attempt
          FROM runs WHERE env = $1 AND started_at >= $2 AND started_at < $3 ORDER BY started_at LIMIT 200000`,
  },
  retention: {
    perm: "export",
    byDay: true,
    sql: `SELECT cohort_day, day_offset, cohort_size, retained, round(100.0 * retained / NULLIF(cohort_size,0), 2) AS pct, timezone
          FROM retention_cohorts WHERE env = $1 AND cohort_day BETWEEN $2::date AND $3::date ORDER BY cohort_day, day_offset`,
  },
};

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  // neutralise spreadsheet formula injection, then quote
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ dataset: string }> }) => {
  const { dataset } = await ctx.params;
  const name = dataset.replace(/\.csv$/, "");
  const d = DATASETS[name];
  if (!d) throw new HttpError(404, "unknown dataset");
  const u = await requireUser(req, d.perm);
  const q = rangeQuery.parse(searchParams(req));
  const s = await getSettings(pool());
  const r = await resolveRange(pool(), q, s.reporting_timezone, new Date(), await envTrackingStart(pool(), q.env));
  const params: unknown[] = d.byDay ? [q.env, r.fromDay, r.toDay] : [q.env, r.from, r.to];
  const res = await pool().query<Record<string, unknown>>(d.sql, params);
  const cols = res.fields.map((f) => f.name);
  const lines = [cols.join(","), ...res.rows.map((row) => cols.map((c) => csvCell(row[c])).join(","))];
  await audit(u.id, "export", name, { env: q.env, range: q.range, rows: res.rows.length }, clientIp(req));
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tls-${name}-${q.env}-${r.fromDay}_${r.toDay}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
