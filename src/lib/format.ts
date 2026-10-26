/** Display formatting. Every function returns "—" for missing values, never a fake 0. */

export const DASH = "—";

export function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return Math.round(v).toLocaleString("en-US");
}

export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  if (Math.abs(v) < 10_000) return fmtInt(v);
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

export function fmtDec(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(digits)}%`;
}

export function fmtRobux(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `R$ ${fmtInt(v)}`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return DASH;
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtHours(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return DASH;
  const h = sec / 3600;
  return h < 10 ? `${h.toFixed(1)} h` : `${fmtInt(h)} h`;
}

export function fmtTime(iso: string | null | undefined, tz: string, withDate = false): string {
  if (!iso) return DASH;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    ...(withDate ? { day: "numeric", month: "short" } : {}),
  }).format(new Date(iso));
}

export function fmtDateTime(iso: string | null | undefined, tz: string): string {
  if (!iso) return DASH;
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/** x-axis label for a series bucket: 'YYYY-MM-DD' days or ISO hours/minutes */
export function fmtBucket(t: string, granularity: "minute" | "hour" | "day", tz: string): string {
  if (granularity === "day") {
    const d = new Date(`${t}T12:00:00Z`);
    return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(d);
  }
  return fmtTime(t, tz);
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export const COUNTRY = (code: string) => {
  if (!code || code === "??") return "Unknown";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
};
