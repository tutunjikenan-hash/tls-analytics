import type { Queryable } from "./db";
import { q } from "./db";

export interface AppSettings {
  reporting_timezone: string;
  raw_event_retention_days: number;
  heartbeat_retention_days: number;
  session_timeout_seconds: number;
  creator_share: number;
  tracking_started_at: string | null;
  gameplay_funnel: string[];
  daily_report_hour: number;
  reports_enabled: boolean;
}

const DEFAULTS: AppSettings = {
  reporting_timezone: "UTC",
  raw_event_retention_days: 90,
  heartbeat_retention_days: 14,
  session_timeout_seconds: 45,
  creator_share: 0.7,
  tracking_started_at: null,
  gameplay_funnel: ["lobby_joined", "gate_entered", "run_start", "first_customer", "final_hour", "run_complete"],
  daily_report_hour: 9,
  reports_enabled: true,
};

let cached: { s: AppSettings; at: number } | null = null;

export async function getSettings(db?: Queryable, fresh = false): Promise<AppSettings> {
  if (!fresh && cached && Date.now() - cached.at < 15_000) return cached.s;
  const rows = db
    ? (await db.query<{ key: string; value: unknown }>("SELECT key, value FROM settings")).rows
    : await q<{ key: string; value: unknown }>("SELECT key, value FROM settings");
  const s = { ...DEFAULTS } as Record<string, unknown>;
  for (const r of rows) if (r.key in DEFAULTS && r.value !== null) s[r.key] = r.value;
  if (rows.find((r) => r.key === "tracking_started_at")?.value === null) s.tracking_started_at = null;
  cached = { s: s as unknown as AppSettings, at: Date.now() };
  return cached.s;
}

export function invalidateSettings() {
  cached = null;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
