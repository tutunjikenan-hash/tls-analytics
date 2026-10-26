"use client";

import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Spark, TimeChart } from "@/components/charts/charts";
import { Delta, Kpi } from "@/components/kpi";
import { LoadError, Loading, NoDataYet, PageHeader } from "@/components/page";
import { Button, Dialog, Panel, Switch } from "@/components/ui/primitives";
import { useLiveStream, useMetrics, useRangeState } from "@/lib/client";
import { fmtCompact, fmtDuration, fmtHours, fmtInt, fmtRobux, fmtTime } from "@/lib/format";
import type { overview } from "@/server/metrics/overview";

type Data = Awaited<ReturnType<typeof overview>> & { revenueHidden?: boolean };
type K = Data["kpis"][keyof Data["kpis"]];

interface Widget {
  id: string;
  label: string;
  kpi: keyof Data["kpis"];
  format: (v: number | null) => string;
  hint: string;
  revenue?: boolean;
  invert?: boolean;
}

const WIDGETS: Widget[] = [
  { id: "visits", label: "Visits", kpi: "visits", format: fmtInt, hint: "Experience visits started in the range. Moving from the lobby to a shift server continues the same visit." },
  { id: "active", label: "Active players", kpi: "activePlayers", format: fmtInt, hint: "Distinct players who were in the game at any moment in the range." },
  { id: "dau", label: "DAU (today)", kpi: "dau", format: fmtInt, hint: "Distinct players today, reporting time zone." },
  { id: "wau", label: "WAU", kpi: "wau", format: fmtInt, hint: "Distinct players in the last 7 days." },
  { id: "new", label: "New players", kpi: "newPlayers", format: fmtInt, hint: "Players first seen by this dashboard in the range." },
  { id: "returning", label: "Returning players", kpi: "returningPlayers", format: fmtInt, hint: "Active players in the range who had been seen before it." },
  { id: "avgplay", label: "Avg playtime", kpi: "avgPlaytime", format: fmtDuration, hint: "Average length of finished visits that started in the range (first join to last leave)." },
  { id: "sessions", label: "Sessions", kpi: "sessions", format: fmtInt, hint: "Server sessions started (one per server a player joined). A visit can have several." },
  { id: "peak", label: "Peak CCU", kpi: "peakCcu", format: fmtInt, hint: "Highest concurrent players, sampled every 15 seconds." },
  { id: "playtime", label: "Total playtime", kpi: "totalPlaytime", format: fmtHours, hint: "Sum of all time players spent in the game during the range." },
  { id: "revenue", label: "Revenue", kpi: "revenue", format: fmtRobux, hint: "Gross Robux of confirmed purchases in the range. Not your payout.", revenue: true },
  { id: "rev-today", label: "Revenue today", kpi: "revenueToday", format: fmtRobux, hint: "Gross Robux of confirmed purchases today.", revenue: true },
  { id: "rev-7d", label: "Revenue 7 days", kpi: "revenue7d", format: fmtRobux, hint: "Gross Robux, last 7 days.", revenue: true },
  { id: "rev-30d", label: "Revenue 30 days", kpi: "revenue30d", format: fmtRobux, hint: "Gross Robux, last 30 days.", revenue: true },
  { id: "rev-life", label: "Revenue, lifetime tracked", kpi: "revenueLifetime", format: fmtRobux, hint: "Everything this dashboard has recorded since tracking began.", revenue: true },
  { id: "life-visits", label: "Lifetime visits, tracked", kpi: "lifetimeVisits", format: fmtCompact, hint: "Visits recorded by this dashboard since tracking began. Roblox's own lifetime count is shown separately." },
  { id: "visits-today", label: "Visits today", kpi: "visitsToday", format: fmtInt, hint: "Visits started today." },
  { id: "sessions-today", label: "Sessions today", kpi: "sessionsToday", format: fmtInt, hint: "Server sessions started today." },
];
const DEFAULT_LAYOUT = ["visits", "active", "new", "returning", "avgplay", "peak", "revenue", "rev-life", "dau", "wau", "playtime", "life-visits"];
const STORE = "tls.overview.widgets.v1";

function useLayout() {
  const [ids, setIds] = useState<string[]>(DEFAULT_LAYOUT);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
      if (Array.isArray(saved)) setIds(saved.filter((x) => WIDGETS.some((w) => w.id === x)));
    } catch {
      /* storage unavailable: defaults */
    }
  }, []);
  const save = (next: string[]) => {
    setIds(next);
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  return [ids, save] as const;
}

export default function OverviewPage() {
  const { state } = useRangeState();
  const { data, error } = useMetrics<Data>("overview");
  const { snap } = useLiveStream(state.env);
  const [layout, setLayout] = useLayout();
  const [editing, setEditing] = useState(false);

  const widgets = useMemo(() => layout.map((id) => WIDGETS.find((w) => w.id === id)!).filter((w) => w && !(w.revenue && data?.revenueHidden)), [layout, data?.revenueHidden]);

  if (error && !data) return <LoadError error={error} />;
  if (!data) return <Loading />;
  const tz = data.range.tz;
  const g = data.range.granularity;
  const ccu = snap?.ccu ?? data.live.ccu;
  const servers = snap?.servers ?? data.live.servers;
  const prevLabel = data.range.preset === "today" ? "yesterday so far" : "previous period";
  const series = data.series.map((p) => ({ ...p, playtimeH: p.playtimeSec === null ? null : Math.round((p.playtimeSec / 3600) * 10) / 10, returning: p.players === null || p.newPlayers === null ? null : Math.max(0, p.players - p.newPlayers) }));

  return (
    <>
      <PageHeader title="Overview" range={data.range} freshness={data.freshness} generatedAt={data.generatedAt} exportDataset={g === "day" ? "daily" : "hourly"}>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><SlidersHorizontal className="h-3.5 w-3.5" /> Customize</Button>
      </PageHeader>

      <section className="canopy mb-4 overflow-hidden rounded-xl border border-line bg-surface-1 px-6 pb-4 pt-6" aria-label="Live now">
        <div className="relative grid gap-6 md:grid-cols-[minmax(0,320px)_1fr]">
          <div>
            <div className="flex items-center gap-2 text-[13px] text-ink-2"><span className="live-dot" aria-hidden /> On shift right now</div>
            <div className="num mt-2 text-[56px] font-semibold leading-[60px] tracking-[-0.03em] text-ink">{fmtInt(ccu)}</div>
            <p className="mt-1 text-[13px] text-ink-3">
              players on {fmtInt(servers)} {servers === 1 ? "server" : "servers"}
              {data.live.peakToday !== null && <> · peak today {fmtInt(Math.max(data.live.peakToday, ccu))}{ccu <= data.live.peakToday && <> at {fmtTime(data.live.peakTodayAt, tz)}</>}</>}
            </p>
          </div>
          <div className="min-w-0 self-end">
            <div className="mb-1 flex justify-between text-[12px] text-ink-3"><span>Concurrent players, last 24 hours</span><span>now</span></div>
            {data.hasData ? <Spark data={data.ccu24h} height={84} /> : <div className="grid h-[84px] place-items-center text-[13px] text-ink-3">No CCU samples yet</div>}
          </div>
        </div>
      </section>

      {!data.hasData ? (
        <NoDataYet env={data.env} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
            {widgets.map((w) => {
              const k = data.kpis[w.kpi] as K | undefined;
              if (!k) return null;
              return (
                <Kpi
                  key={w.id}
                  label={w.label}
                  value={w.format(k.value)}
                  hint={<>{w.hint}{k.note ? <><br /><br />{k.note}</> : null}</>}
                  delta={k.previous !== null || k.changePct !== null ? <Delta pct={k.changePct} invert={w.invert} previous={undefined} /> : null}
                  sub={k.previous !== null ? `vs ${prevLabel}` : undefined}
                />
              );
            })}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Visits and active players" subtitle={g === "day" ? "Per day" : "Per hour"}>
              <TimeChart data={series} granularity={g} tz={tz} defs={[{ key: "visits", label: "Visits" }, { key: "players", label: "Active players" }]} />
            </Panel>
            <Panel title="New and returning players" subtitle={g === "day" ? "Per day" : "Per hour"}>
              <TimeChart data={series} granularity={g} tz={tz} defs={[{ key: "newPlayers", label: "New" }, { key: "returning", label: "Returning" }]} />
            </Panel>
            <Panel title="Playtime" subtitle="Hours played">
              <TimeChart data={series} granularity={g} tz={tz} kind="bar" defs={[{ key: "playtimeH", label: "Hours", format: (v) => (v === null ? "no data" : `${v} h`) }]} />
            </Panel>
            {data.revenueHidden ? (
              <Panel title="Peak concurrent players"><TimeChart data={series} granularity={g} tz={tz} defs={[{ key: "peakCcu", label: "Peak CCU" }]} kind="area" /></Panel>
            ) : (
              <Panel title="Revenue" subtitle="Gross Robux from confirmed purchases">
                <TimeChart data={series} granularity={g} tz={tz} kind="bar" defs={[{ key: "revenueRobux", label: "Robux", format: (v) => fmtRobux(v) }]} />
              </Panel>
            )}
          </div>

          <RobloxReported data={data} />
        </>
      )}

      <Dialog open={editing} onOpenChange={setEditing} title="Customize overview" description="Choose which numbers appear and in what order. Saved in this browser.">
        <ul className="flex flex-col gap-1">
          {[...layout.map((id) => WIDGETS.find((w) => w.id === id)!), ...WIDGETS.filter((w) => !layout.includes(w.id))]
            .filter((w) => !(w.revenue && data.revenueHidden))
            .map((w) => {
              const on = layout.includes(w.id);
              const i = layout.indexOf(w.id);
              return (
                <li key={w.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                  <Switch label={`Show ${w.label}`} checked={on} onCheckedChange={(v) => setLayout(v ? [...layout, w.id] : layout.filter((x) => x !== w.id))} />
                  <span className="flex-1 text-[14px] text-ink">{w.label}</span>
                  <Button size="icon" variant="ghost" aria-label={`Move ${w.label} up`} disabled={!on || i === 0} onClick={() => { const n = [...layout]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setLayout(n); }}><ArrowUp className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Move ${w.label} down`} disabled={!on || i === layout.length - 1} onClick={() => { const n = [...layout]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setLayout(n); }}><ArrowDown className="h-3.5 w-3.5" /></Button>
                </li>
              );
            })}
        </ul>
        <div className="mt-4 flex justify-end"><Button size="sm" variant="ghost" onClick={() => setLayout(DEFAULT_LAYOUT)}>Reset to default</Button></div>
      </Dialog>
    </>
  );
}

function RobloxReported({ data }: { data: Data }) {
  const r = data.robloxReported;
  const items = [
    { k: "visits", label: "Lifetime visits" },
    { k: "favorites", label: "Favorites" },
    { k: "playing", label: "Playing now" },
  ].filter((i) => r[i.k]);
  return (
    <Panel className="mt-4" title="As reported by Roblox" subtitle="Roblox's own public numbers, shown apart from what this dashboard measures. They include history from before tracking began.">
      {items.length === 0 ? (
        <p className="text-[13px] text-ink-3">Not connected. Set ROBLOX_UNIVERSE_ID on the server to fetch the public counts every 10 minutes, or add a number by hand in Settings.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {items.map((i) => (
            <div key={i.k}>
              <div className="text-[13px] text-ink-2">{i.label}</div>
              <div className="num text-[22px] font-semibold text-ink">{fmtInt(r[i.k].value)}</div>
              <div className="text-[12px] text-ink-3">{r[i.k].source === "manual" ? "entered by hand" : "games API"}, {fmtTime(r[i.k].asOf, data.range.tz, true)}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
