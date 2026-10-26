import type { Queryable } from "../db";
import { addDays, localDay } from "./rollups";
import { overview } from "../metrics/overview";
import { gameplayPage } from "../metrics/gameplay";
import { getSettings } from "../settings";
import { COLORS, postDiscord, type DiscordEmbed } from "./discord";

const fmtDur = (s: number | null) => (s === null ? "—" : s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);
const fmtPct = (p: number | null) => (p === null ? "" : ` (${p >= 0 ? "+" : ""}${p.toFixed(0)}%)`);
const n = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 0 }));

/** Builds the Discord summary for a whole-day period [fromDay, toDay] compared with the period before. */
export async function buildReport(db: Queryable, fromDay: string, toDay: string, title: string, now: Date): Promise<DiscordEmbed> {
  const o = await overview(db, { range: "custom", from: fromDay, to: toDay, env: "production" }, now);
  const g = await gameplayPage(db, { range: "custom", from: fromDay, to: toDay, env: "production" }, now);
  const k = o.kpis;
  const field = (name: string, kp: { value: number | null; changePct: number | null }, f = n) => ({ name, value: `${f(kp.value)}${fmtPct(kp.changePct)}`, inline: true });
  return {
    title,
    description: o.hasData ? `${fromDay === toDay ? fromDay : `${fromDay} → ${toDay}`} · ${o.range.tz} · compared with the previous period` : "No data tracked yet.",
    color: COLORS.report,
    fields: o.hasData
      ? [
          field("Visits", k.visits),
          field("Active players", k.activePlayers),
          field("New players", k.newPlayers),
          field("Avg visit", k.avgPlaytime, fmtDur),
          field("Peak CCU", k.peakCcu),
          field("Revenue (gross R$)", k.revenue),
          { name: "Shift completion", value: g.runs.completionPct === null ? "—" : `${g.runs.completionPct.toFixed(0)}% of ${g.runs.started} runs`, inline: true },
          { name: "Lifetime visits (tracked)", value: n(k.lifetimeVisits.value), inline: true },
        ]
      : [],
    footer: { text: "TLS Analytics · gross Robux spent, not payouts" },
    timestamp: now.toISOString(),
  };
}

/** Sends the daily (and on Mondays the weekly) report once, at the configured local hour. */
export async function maybeSendReports(db: Queryable, now = new Date()): Promise<string[]> {
  const s = await getSettings(db, true);
  if (!s.reports_enabled) return [];
  const tz = s.reporting_timezone;
  const today = localDay(now, tz);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));
  if (hour < s.daily_report_hour) return [];
  const sent: string[] = [];
  const yesterday = addDays(today, -1);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); // 1 = Monday
  const jobs: Array<{ kind: string; key: string; from: string; to: string; title: string }> = [
    { kind: "daily", key: yesterday, from: yesterday, to: yesterday, title: `📊 Daily report — ${yesterday}` },
  ];
  if (weekday === 1) jobs.push({ kind: "weekly", key: `week-ending-${yesterday}`, from: addDays(today, -7), to: yesterday, title: `📈 Weekly report — ${addDays(today, -7)} to ${yesterday}` });
  for (const j of jobs) {
    // claim the period; a failed send is retried every 15 minutes, a successful one never repeats
    const claimed = await db.query(
      `INSERT INTO report_runs (kind, period_key, ok) VALUES ($1,$2,false)
       ON CONFLICT (kind, period_key) DO UPDATE SET sent_at = now()
         WHERE report_runs.ok = false AND report_runs.sent_at < now() - interval '15 minutes'
       RETURNING kind`,
      [j.kind, j.key],
    );
    if ((claimed.rowCount ?? 0) === 0) continue;
    const embed = await buildReport(db, j.from, j.to, j.title, now);
    const error = await postDiscord([embed]);
    await db.query(`UPDATE report_runs SET ok = $3, error = $4, sent_at = now() WHERE kind = $1 AND period_key = $2`, [j.kind, j.key, error === null, error]);
    sent.push(`${j.kind}:${j.key}${error ? ` (failed: ${error})` : ""}`);
  }
  return sent;
}
