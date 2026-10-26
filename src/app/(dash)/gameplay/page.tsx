"use client";

import { useState } from "react";
import { BarList, CategoryBars } from "@/components/charts/charts";
import { Kpi } from "@/components/kpi";
import { LoadError, Loading, NoDataYet, PageHeader } from "@/components/page";
import { Empty, Panel, Select, Table } from "@/components/ui/primitives";
import { useMetrics } from "@/lib/client";
import { fmtDec, fmtDuration, fmtInt, fmtPct } from "@/lib/format";
import type { gameplayPage } from "@/server/metrics/gameplay";

type Data = Awaited<ReturnType<typeof gameplayPage>>;

export default function GameplayPage() {
  const [chapter, setChapter] = useState("all");
  const { data, error } = useMetrics<Data>("gameplay", chapter !== "all" ? `chapter=${encodeURIComponent(chapter)}` : "");
  if (error && !data) return <LoadError error={error} />;
  if (!data) return <Loading />;
  const r = data.runs;
  return (
    <>
      <PageHeader title="Gameplay" description="Runs are shifts and chapter attempts, as the game reports them." range={data.range} freshness={data.freshness} generatedAt={data.generatedAt} exportDataset="runs">
        {data.chapters.length > 0 && (
          <Select label="Chapter" value={chapter} onValueChange={setChapter} options={[{ value: "all", label: "All chapters" }, ...data.chapters.map((c) => ({ value: c, label: c }))]} />
        )}
      </PageHeader>
      {!data.hasData ? (
        <NoDataYet env={data.env} />
      ) : !data.instrumented ? (
        <Panel><Empty title="No gameplay events in this range">Players are being counted, but no run or gameplay events arrived. Check that TLSAnalyticsGameHooks is installed (docs/INSTRUMENTATION.md).</Empty></Panel>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Runs started" value={fmtInt(r.started)} sub={`${fmtInt(r.players)} players`} />
            <Kpi label="Completion rate" value={fmtPct(r.completionPct)} hint="Completed ÷ finished runs (completed, failed or abandoned). Runs still going are not counted." sub={`${fmtInt(r.completed)} completed`} />
            <Kpi label="Failed" value={fmtInt(r.failed)} />
            <Kpi label="Left before finishing" value={fmtPct(r.leftBeforeFinishingPct)} hint="Abandoned ÷ finished runs. A run is abandoned when the player leaves, or is gone for 10 minutes, without an ending." sub={`${fmtInt(r.abandoned)} runs`} />
            <Kpi label="Median time to complete" value={fmtDuration(r.medianCompleteSec)} sub={r.avgCompleteSec !== null ? `average ${fmtDuration(r.avgCompleteSec)}` : undefined} />
            <Kpi label="In progress" value={fmtInt(r.inProgress)} hint="Runs started in the range with no ending yet." />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Funnel" subtitle="Players who reached each step, in order (Settings → Funnel)">
              <ol className="flex flex-col gap-2">
                {data.funnel.map((f, i) => {
                  const prev = i > 0 ? data.funnel[i - 1].players : null;
                  const drop = prev ? ((prev - f.players) / prev) * 100 : null;
                  return (
                    <li key={f.step} className="grid grid-cols-[140px_1fr_auto] items-center gap-3 text-[13px]">
                      <span className="truncate text-ink-2" title={f.step}>{f.step}</span>
                      <span className="relative h-6 rounded-[4px] bg-surface-2">
                        <span className="absolute inset-y-0 left-0 rounded-[4px] bg-s1" style={{ width: `${f.pctOfFirst ?? 0}%` }} />
                      </span>
                      <span className="num w-[150px] text-right text-ink">
                        {fmtInt(f.players)} <span className="text-ink-3">{f.pctOfFirst !== null ? `${f.pctOfFirst.toFixed(0)}%` : ""}{drop !== null && drop > 0 ? `, −${drop.toFixed(0)}%` : ""}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </Panel>
            <Panel title="Deaths by cause" subtitle="death events, props.cause">
              <BarList items={data.deathsByCause.map((d) => ({ label: d.cause, value: d.deaths }))} empty="No death events in this range" />
            </Panel>
            <Panel title="Where players die" subtitle="death events by area">
              <BarList items={data.deathsByArea.map((d) => ({ label: d.area, value: d.deaths, sub: `${d.players} players` }))} empty="No death events in this range" />
            </Panel>
            <Panel title="Where players leave" subtitle="Stage reached in abandoned runs">
              <BarList items={data.abandonedAtStage.map((d) => ({ label: d.stage, value: d.runs }))} empty="No abandoned runs in this range" />
            </Panel>
            <Panel title="Time to complete" subtitle="Completed runs">
              <CategoryBars data={data.completionTimes} xKey="bucket" yKey="runs" label="Runs" />
            </Panel>
            <Panel title="Attempts needed" subtitle="Completions by attempt number for that chapter and stage">
              <CategoryBars data={data.completionsByAttempt} xKey="attempt" yKey="completions" label="Completions" />
            </Panel>
          </div>

          <Panel className="mt-4" title="Difficulty by stage" subtitle="Sorted by chapter and stage">
            <Table
              rows={data.stages as unknown as Record<string, unknown>[]}
              columns={[
                { key: "chapter", label: "Chapter" },
                { key: "stage", label: "Stage", render: (x) => <span className="text-ink">{String(x.stage)}</span> },
                { key: "started", label: "Started", align: "right" },
                { key: "completionPct", label: "Completed", align: "right", render: (x) => fmtPct(x.completionPct as number | null, 0) },
                { key: "failPct", label: "Failed", align: "right", render: (x) => fmtPct(x.failPct as number | null, 0) },
                { key: "abandoned", label: "Abandoned", align: "right" },
                { key: "avgCompleteSec", label: "Avg time", align: "right", render: (x) => fmtDuration(x.avgCompleteSec as number | null) },
                { key: "avgAttempt", label: "Avg attempt", align: "right", render: (x) => fmtDec(x.avgAttempt as number | null, 1) },
              ]}
            />
          </Panel>
          <Panel className="mt-4" title="All gameplay events" subtitle="Everything the game sent through TLSAnalytics.track">
            <Table dense rows={data.events as unknown as Record<string, unknown>[]} columns={[{ key: "name", label: "Event", render: (x) => <code className="text-ink">{String(x.name)}</code> }, { key: "count", label: "Count", align: "right" }, { key: "players", label: "Players", align: "right" }]} />
          </Panel>
        </>
      )}
    </>
  );
}
