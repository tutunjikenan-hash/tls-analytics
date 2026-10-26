import { z } from "zod";
import type { Queryable } from "../db";

export const RANGE_PRESETS = ["live", "today", "yesterday", "7d", "30d", "90d", "custom", "all"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const rangeQuery = z.object({
  range: z.enum(RANGE_PRESETS).default("today"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // custom: first reporting day (inclusive)
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // custom: last reporting day (inclusive)
  env: z.enum(["production", "studio", "simulation"]).default("production"),
});
export type RangeQuery = z.infer<typeof rangeQuery>;

export interface Window {
  from: Date; // inclusive
  to: Date; // exclusive (now, for periods still in progress)
  fromDay: string; // reporting-time-zone days covered (inclusive)
  toDay: string;
}

export interface ResolvedRange extends Window {
  preset: RangePreset;
  tz: string;
  label: string;
  /** whole reporting days (true) or a sub-day window (live) */
  wholeDays: boolean;
  granularity: "minute" | "hour" | "day";
  previous: Window | null;
  complete: boolean; // false while the period is still running
}

const LABELS: Record<RangePreset, string> = {
  live: "Last 60 minutes",
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  custom: "Custom range",
  all: "All time",
};

/**
 * Resolves a preset into exact UTC boundaries using the reporting time zone. Periods that are still
 * running end at `now`, and their comparison period is the same length shifted back (so "today so
 * far" is compared with "yesterday up to the same time").
 */
export async function resolveRange(db: Queryable, q: RangeQuery, tz: string, now = new Date(), trackingStart?: Date | null): Promise<ResolvedRange> {
  const { rows } = await db.query<{ today: string }>(`SELECT to_char(($1::timestamptz AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS today`, [now, tz]);
  const today = rows[0].today;
  const dayStart = async (day: string) =>
    (await db.query<{ t: Date }>(`SELECT ($1::date::timestamp AT TIME ZONE $2) AS t`, [day, tz])).rows[0].t;
  const add = (day: string, n: number) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

  if (q.range === "live") {
    const from = new Date(now.getTime() - 60 * 60 * 1000);
    return {
      preset: "live", tz, label: LABELS.live, wholeDays: false, granularity: "minute", complete: false,
      from, to: now, fromDay: today, toDay: today,
      previous: { from: new Date(from.getTime() - 3600_000), to: from, fromDay: today, toDay: today },
    };
  }

  let fromDay: string;
  let toDay: string;
  switch (q.range) {
    case "today": fromDay = toDay = today; break;
    case "yesterday": fromDay = toDay = add(today, -1); break;
    case "7d": fromDay = add(today, -6); toDay = today; break;
    case "30d": fromDay = add(today, -29); toDay = today; break;
    case "90d": fromDay = add(today, -89); toDay = today; break;
    case "custom": {
      if (!q.from || !q.to) throw new RangeError("custom range needs from and to (YYYY-MM-DD)");
      fromDay = q.from <= q.to ? q.from : q.to;
      toDay = q.from <= q.to ? q.to : q.from;
      if (toDay > today) toDay = today;
      if (dayDiff(fromDay, toDay) > 730) throw new RangeError("custom ranges are limited to two years");
      break;
    }
    case "all": {
      const start = trackingStart ? (await db.query<{ d: string }>(`SELECT to_char(($1::timestamptz AT TIME ZONE $2)::date,'YYYY-MM-DD') AS d`, [trackingStart, tz])).rows[0].d : today;
      fromDay = start;
      toDay = today;
      break;
    }
    default: fromDay = toDay = today;
  }
  const from = await dayStart(fromDay);
  const endOfTo = await dayStart(add(toDay, 1));
  const running = toDay >= today;
  const to = running ? now : endOfTo;
  const ndays = dayDiff(fromDay, toDay) + 1;
  let previous: Window | null = null;
  if (q.range !== "all") {
    const pFromDay = add(fromDay, -ndays);
    const pToDay = add(toDay, -ndays);
    const pFrom = await dayStart(pFromDay);
    const pTo = running ? new Date(pFrom.getTime() + (to.getTime() - from.getTime())) : await dayStart(add(pToDay, 1));
    previous = { from: pFrom, to: pTo, fromDay: pFromDay, toDay: pToDay };
  }
  return {
    preset: q.range, tz, label: q.range === "custom" ? `${fromDay} → ${toDay}` : LABELS[q.range], wholeDays: true,
    granularity: ndays <= 2 ? "hour" : "day", complete: !running, from, to, fromDay, toDay, previous,
  };
}
