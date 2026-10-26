"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtBucket } from "@/lib/format";
import { cn } from "@/lib/utils";

export const SERIES = ["var(--color-s1)", "var(--color-s2)", "var(--color-s3)", "var(--color-s4)", "var(--color-s5)"];
const AXIS = { stroke: "var(--color-ink-3)", fontSize: 12, tickLine: false, axisLine: false } as const;

export interface SeriesDef {
  key: string;
  label: string;
  format?: (v: number | null) => string;
}

type Row = { t: string };

function ChartTooltip({ active, payload, label, defs, labelFmt }: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number | null; color: string }>;
  label?: string;
  defs: SeriesDef[];
  labelFmt: (t: string) => string;
}) {
  if (!active || !payload?.length || label === undefined) return null;
  return (
    <div className="rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-[12px] shadow-xl shadow-black/40">
      <div className="mb-1 text-ink-3">{labelFmt(String(label))}</div>
      {defs.map((d, i) => {
        const p = payload.find((x) => x.dataKey === d.key);
        const v = p?.value ?? null;
        return (
          <div key={d.key} className="flex items-center justify-between gap-5">
            <span className="flex items-center gap-1.5 text-ink-2">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: SERIES[i] }} />
              {d.label}
            </span>
            <span className="num font-medium text-ink">{v === null ? "no data" : d.format ? d.format(v) : v.toLocaleString("en-US")}</span>
          </div>
        );
      })}
    </div>
  );
}

function Legend({ defs }: { defs: SeriesDef[] }) {
  if (defs.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
      {defs.map((d, i) => (
        <span key={d.key} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[3px] w-3 rounded-full" style={{ background: SERIES[i] }} />
          {d.label}
        </span>
      ))}
    </div>
  );
}

/** Time series as lines (several measures of the same unit) or an area (one measure). */
export function TimeChart({ data, defs, granularity, tz, height = 220, kind = "line", yFormat, xFormat, className }: {
  data: object[];
  defs: SeriesDef[];
  granularity: "minute" | "hour" | "day";
  tz: string;
  height?: number;
  kind?: "line" | "area" | "bar";
  yFormat?: (v: number) => string;
  xFormat?: (t: string) => string;
  className?: string;
}) {
  const labelFmt = xFormat ?? ((t: string) => fmtBucket(t, granularity, tz));
  const common = {
    data,
    margin: { top: 6, right: 6, bottom: 0, left: 0 },
  };
  const grid = <CartesianGrid vertical={false} stroke="var(--color-line)" strokeDasharray="0" />;
  const x = <XAxis dataKey="t" {...AXIS} tickFormatter={labelFmt} minTickGap={28} />;
  const y = <YAxis {...AXIS} width={44} allowDecimals={false} tickFormatter={yFormat ?? ((v: number) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v)))} />;
  const tip = <Tooltip cursor={kind === "bar" ? { fill: "var(--color-surface-2)" } : { stroke: "var(--color-line-strong)" }} content={<ChartTooltip defs={defs} labelFmt={labelFmt} />} />;
  return (
    <div className={cn("w-full", className)}>
      <Legend defs={defs} />
      <div style={{ height }} role="img" aria-label={`${defs.map((d) => d.label).join(", ")} over time`}>
        <ResponsiveContainer width="100%" height="100%">
          {kind === "bar" ? (
            <BarChart {...common} barCategoryGap={2}>
              {grid}{x}{y}{tip}
              {defs.map((d, i) => (
                <Bar key={d.key} dataKey={d.key} fill={SERIES[i]} radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={28} />
              ))}
            </BarChart>
          ) : kind === "area" ? (
            <AreaChart {...common}>
              <defs>
                <linearGradient id={`fill-${defs[0].key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0} />
                </linearGradient>
              </defs>
              {grid}{x}{y}{tip}
              <Area type="monotone" dataKey={defs[0].key} stroke={SERIES[0]} strokeWidth={2} fill={`url(#fill-${defs[0].key})`} connectNulls={false} isAnimationActive={false} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-surface-1)" }} />
            </AreaChart>
          ) : (
            <LineChart {...common}>
              {grid}{x}{y}{tip}
              {defs.map((d, i) => (
                <Line key={d.key} type="monotone" dataKey={d.key} stroke={SERIES[i]} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-surface-1)" }} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Distribution / category counts as vertical bars with category labels. */
export function CategoryBars({ data, xKey, yKey, label, height = 200, format }: {
  data: Array<Record<string, unknown>>;
  xKey: string;
  yKey: string;
  label: string;
  height?: number;
  format?: (v: number) => string;
}) {
  return (
    <div style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="var(--color-line)" />
          <XAxis dataKey={xKey} {...AXIS} interval="preserveStartEnd" minTickGap={6} />
          <YAxis {...AXIS} width={40} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: "var(--color-surface-2)" }}
            content={({ active, payload, label: l }) =>
              active && payload?.length ? (
                <div className="rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-[12px] shadow-xl shadow-black/40">
                  <div className="text-ink-3">{String(l)}</div>
                  <div className="num font-medium text-ink">{format ? format(Number(payload[0].value)) : Number(payload[0].value).toLocaleString("en-US")} {label.toLowerCase()}</div>
                </div>
              ) : null
            }
          />
          <Bar dataKey={yKey} fill={SERIES[0]} radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={44} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Ranked list with inline bars (top products, countries, areas). Plain HTML: readable, accessible. */
export function BarList({ items, format, empty = "No data in this period" }: {
  items: Array<{ label: string; value: number; sub?: string }>;
  format?: (v: number) => string;
  empty?: string;
}) {
  if (!items.length) return <p className="py-6 text-center text-[13px] text-ink-3">{empty}</p>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((it) => (
        <li key={it.label} className="group relative flex items-center justify-between gap-3 rounded-md px-2 py-1.5" title={`${it.label}: ${format ? format(it.value) : it.value}`}>
          <span className="absolute inset-y-0 left-0 rounded-md bg-s1/20 group-hover:bg-s1/30" style={{ width: `${(it.value / max) * 100}%` }} aria-hidden />
          <span className="relative truncate text-[13px] text-ink">{it.label}{it.sub && <span className="ml-2 text-ink-3">{it.sub}</span>}</span>
          <span className="num relative text-[13px] font-medium text-ink-2">{format ? format(it.value) : it.value.toLocaleString("en-US")}</span>
        </li>
      ))}
    </ul>
  );
}

/** Sparkline for the live hero (no axes; tooltip on hover). */
export function Spark({ data, height = 64 }: { data: Array<{ t: string; ccu: number | null }>; height?: number }) {
  return (
    <div style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-sodium)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--color-sodium)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Tooltip cursor={{ stroke: "var(--color-line-strong)" }} content={({ active, payload }) => active && payload?.length ? (
            <div className="rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-[12px] text-ink num">{payload[0].value === null ? "no data" : `${payload[0].value} players`}</div>
          ) : null} />
          <Area type="monotone" dataKey="ccu" stroke="var(--color-sodium)" strokeWidth={2} fill="url(#spark)" connectNulls={false} isAnimationActive={false} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
