"use client";

import { CategoryBars, TimeChart } from "@/components/charts/charts";
import { Delta, Kpi } from "@/components/kpi";
import { LoadError, Loading, NoDataYet, PageHeader } from "@/components/page";
import { Panel } from "@/components/ui/primitives";
import { useMetrics } from "@/lib/client";
import { fmtDec, fmtDuration, fmtHours, fmtInt, fmtPct } from "@/lib/format";
import type { engagementPage } from "@/server/metrics/engagement";

type Data = Awaited<ReturnType<typeof engagementPage>>;

export default function EngagementPage() {
  const { data, error } = useMetrics<Data>("engagement");
  if (error && !data) return <LoadError error={error} />;
  if (!data) return <Loading />;
  const tz = data.range.tz;
  const g = data.range.granularity;
  const series = data.series.map((p) => ({
    ...p,
    perPlayerMin: p.playtimeSec === null || !p.players ? null : Math.round(p.playtimeSec / p.players / 6) / 10,
    returning: p.players === null || p.newPlayers === null ? null : Math.max(0, p.players - p.newPlayers),
  }));
  return (
    <>
      <PageHeader title="Engagement and playtime" range={data.range} freshness={data.freshness} generatedAt={data.generatedAt} exportDataset="daily" />
      {!data.hasData ? (
        <NoDataYet env={data.env} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Kpi label="Average visit" value={fmtDuration(data.visitLength.avgSec)} hint="Finished visits that started in the range, first join to last leave." delta={data.visitLength.previousAvgSec !== null ? <Delta pct={data.visitLength.changePct} /> : null} sub={`${fmtInt(data.visitLength.closedVisits)} visits`} />
            <Kpi label="Median visit" value={fmtDuration(data.visitLength.medianSec)} hint="Half of visits were shorter than this." />
            <Kpi label="Longest 10%" value={data.visitLength.p90Sec === null ? "—" : `${fmtDuration(data.visitLength.p90Sec)}+`} hint="90th percentile visit length." />
            <Kpi label="Total playtime" value={fmtHours(data.totalPlaytimeSec)} sub={data.playtimePerPlayerSec !== null ? `${fmtDuration(data.playtimePerPlayerSec)} per player` : undefined} />
            <Kpi label="Sessions per player" value={fmtDec(data.sessionsPerPlayer, 2)} hint="Server sessions ÷ active players. Each move between lobby and shift servers is a session." />
            <Kpi label="Stickiness" value={fmtPct(data.stickinessPct)} hint="Average DAU over the last 30 days ÷ MAU. Reads low until 30 days have been tracked." sub={data.stickinessBasisDays < 30 ? `based on ${data.stickinessBasisDays} tracked days` : "DAU ÷ MAU"} />
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Kpi label="DAU" value={fmtInt(data.dau)} sub={`on ${data.range.toDay}`} />
            <Kpi label="WAU" value={fmtInt(data.wau)} sub="7 days to that day" />
            <Kpi label="MAU" value={fmtInt(data.mau)} sub="30 days to that day" />
            <Kpi label="New / returning" value={`${fmtInt(data.newPlayers)} / ${fmtInt(data.returningPlayers)}`} sub={`of ${fmtInt(data.activePlayers)} active`} />
            <Kpi
              label="Churn"
              value={data.churn ? fmtPct(data.churn.churnPct) : "—"}
              hint="Of the players active in the previous period, the share who did not play at all in this one. Whole-day ranges only."
              sub={data.churn ? `${fmtInt(data.churn.churned)} of ${fmtInt(data.churn.previousActive)} did not return` : "needs a previous period with players"}
            />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Visit length" subtitle="Finished visits in the range">
              <CategoryBars data={data.lengthDistribution} xKey="bucket" yKey="visits" label="Visits" />
            </Panel>
            <Panel title="Playtime per active player" subtitle="Minutes">
              <TimeChart data={series} granularity={g} tz={tz} defs={[{ key: "perPlayerMin", label: "Minutes per player", format: (v) => (v === null ? "no data" : `${v} min`) }]} kind="area" />
            </Panel>
            <Panel title="New and returning players">
              <TimeChart data={series} granularity={g} tz={tz} defs={[{ key: "newPlayers", label: "New" }, { key: "returning", label: "Returning" }]} />
            </Panel>
            <Panel title="When people play" subtitle={`Visits by hour of day, ${tz}`}>
              <CategoryBars data={data.byHourOfDay.map((h) => ({ ...h, label: String(h.hour).padStart(2, "0") }))} xKey="label" yKey="visits" label="Visits" />
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
