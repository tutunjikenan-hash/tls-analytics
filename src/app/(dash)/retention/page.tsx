"use client";

import { TimeChart } from "@/components/charts/charts";
import { Kpi } from "@/components/kpi";
import { LoadError, Loading, NoDataYet, PageHeader } from "@/components/page";
import { Empty, Hint, Panel } from "@/components/ui/primitives";
import { useMetrics } from "@/lib/client";
import { fmtInt, fmtPct } from "@/lib/format";
import type { retentionPage } from "@/server/metrics/engagement";

type Data = Awaited<ReturnType<typeof retentionPage>>;

// sequential blue (one hue), dark surface: low values recede, high values brighten
const RAMP = ["#132a4d", "#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef"];
const OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7, 14, 21, 30];

function cellColor(pct: number) {
  const i = Math.min(RAMP.length - 1, Math.floor((pct / 100) * RAMP.length));
  return RAMP[i];
}

export default function RetentionPage() {
  const { data, error } = useMetrics<Data>("retention");
  if (error && !data) return <LoadError error={error} />;
  if (!data) return <Loading />;
  const s = data.summary as Record<string, { pct: number | null; cohorts: number; players: number }>;
  return (
    <>
      <PageHeader title="Retention" description="Calendar-day cohorts." range={data.range} generatedAt={data.generatedAt} exportDataset="retention" />
      {!data.hasData ? (
        <NoDataYet env={data.env} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            {(["d1", "d3", "d7", "d14", "d30"] as const).map((k) => (
              <Kpi
                key={k}
                label={`Day ${k.slice(1)}`}
                value={fmtPct(s[k].pct)}
                hint={`Share of new players who played again exactly ${k.slice(1)} calendar day(s) after their first day, weighted by cohort size.`}
                sub={s[k].cohorts ? `${s[k].cohorts} cohorts, ${fmtInt(s[k].players)} players` : "no finished cohort yet"}
              />
            ))}
          </div>
          <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
            <Panel title="Cohorts" subtitle="Each row: players first seen that day. Cells: share active N days later. Blank = that day is not over yet." actions={<Hint>{data.method}</Hint>}>
              {data.cohorts.length === 0 ? (
                <Empty title="No finished days yet">Retention cells appear once a cohort&apos;s day is over in {data.timezone}. Day 0 for today shows up tomorrow.</Empty>
              ) : (
                <div className="-mx-5 overflow-x-auto px-5">
                  <table className="num w-full min-w-[640px] border-separate border-spacing-[2px] text-[12px]">
                    <thead>
                      <tr className="text-ink-3">
                        <th className="pb-1 text-left font-medium">Cohort</th>
                        <th className="pb-1 text-right font-medium">Players</th>
                        {OFFSETS.map((o) => <th key={o} className="pb-1 text-center font-medium">D{o}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {data.cohorts.map((c) => (
                        <tr key={c.day}>
                          <td className="whitespace-nowrap pr-2 text-ink-2">
                            {c.day}
                            {c.includesPreTracking && <span className="ml-1 text-ink-3" title="First tracked day: includes players who played before tracking began, so it is left out of the averages.">*</span>}
                          </td>
                          <td className="pr-2 text-right text-ink-2">{fmtInt(c.size)}</td>
                          {OFFSETS.map((o) => {
                            const v = c.cells[o];
                            if (v === undefined) return <td key={o} className="h-7 rounded-[4px] bg-surface-2/40" aria-label="not yet" />;
                            const pct = c.size > 0 ? (v / c.size) * 100 : 0;
                            return (
                              <td key={o} className="h-7 rounded-[4px] text-center" style={{ background: cellColor(pct), color: pct > 55 ? "#0d1626" : "var(--color-ink)" }} title={`${c.day} D${o}: ${v} of ${c.size} (${pct.toFixed(1)}%)`}>
                                {pct.toFixed(0)}%
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.cohorts.some((c) => c.includesPreTracking) && <p className="mt-2 text-[12px] text-ink-3">* first tracked day, excluded from the averages.</p>}
                </div>
              )}
            </Panel>
            <Panel title="Retention curve" subtitle="Average across finished cohorts">
              <TimeChart
                data={data.curve.map((p) => ({ t: String(p.day), pct: p.pct === null ? null : Math.round(p.pct * 10) / 10 }))}
                granularity="minute"
                tz="UTC"
                defs={[{ key: "pct", label: "Retained", format: (v) => (v === null ? "no data" : `${v}%`) }]}
                yFormat={(v) => `${v}%`}
                xFormat={(t) => `Day ${t}`}
              />
              <p className="mt-2 text-[12px] text-ink-3">X axis: days since first visit.</p>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
