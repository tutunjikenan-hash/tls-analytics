"use client";

import { BarList, CategoryBars, TimeChart } from "@/components/charts/charts";
import { Kpi } from "@/components/kpi";
import { LoadError, Loading, NoDataYet, PageHeader } from "@/components/page";
import { Panel, Table } from "@/components/ui/primitives";
import { useLiveStream, useMetrics, useNow, useRangeState } from "@/lib/client";
import { ago, COUNTRY, fmtDec, fmtDuration, fmtInt, fmtTime } from "@/lib/format";
import type { livePage } from "@/server/metrics/live";

type Data = Awaited<ReturnType<typeof livePage>>;

export default function LivePage() {
  const { state } = useRangeState();
  const { data, error } = useMetrics<Data>("live", "", { refreshMs: 5000 });
  const { snap } = useLiveStream(state.env);
  const now = useNow(5000);
  if (error && !data) return <LoadError error={error} />;
  if (!data) return <Loading />;
  const tz = data.tz;
  return (
    <>
      <PageHeader title="Live players" description={`Updates every 5 seconds. A player counts as live while their server reports them; after ${data.sessionTimeoutSec} s of silence they drop out.`} generatedAt={data.generatedAt} />
      {!data.hasData ? (
        <NoDataYet env={data.env} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Concurrent players" value={fmtInt(snap?.ccu ?? data.ccu)} size="lg" className="canopy" sub={snap ? `stream ${ago(snap.at, now)}` : undefined} />
            <Kpi label="Active servers" value={fmtInt(snap?.servers ?? data.servers)} sub={data.avgPlayersPerServer !== null ? `${fmtDec(data.avgPlayersPerServer)} players each` : undefined} />
            <Kpi label="Open sessions" value={fmtInt(snap?.sessions ?? data.sessions)} hint="Player-on-server sessions. Higher than CCU only while someone is mid-teleport." />
            <Kpi label="Peak today" value={fmtInt(data.peakToday)} sub={data.peakTodayAt ? `at ${fmtTime(data.peakTodayAt, tz)}` : undefined} />
            <Kpi label="Joins per minute" value={fmtDec(data.joinsPerMin)} hint="Average of the last 5 complete minutes." sub={snap ? `${snap.joinsLastMin} in the last 60 s` : undefined} />
            <Kpi label="Leaves per minute" value={fmtDec(data.leavesPerMin)} hint="Average of the last 5 complete minutes." sub={snap ? `${snap.leavesLastMin} in the last 60 s` : undefined} />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Concurrent players" subtitle="Last 60 minutes, per minute peak">
              <TimeChart data={data.ccuLastHour} granularity="minute" tz={tz} kind="area" defs={[{ key: "ccu", label: "Players" }]} />
            </Panel>
            <Panel title="Joins and leaves" subtitle="Last 60 minutes, per minute">
              <TimeChart data={data.joinsLeaves} granularity="minute" tz={tz} kind="line" defs={[{ key: "joins", label: "Joins" }, { key: "leaves", label: "Leaves" }]} />
            </Panel>
            <Panel title="Where players are" subtitle="Current stage of each live player">
              <BarList items={data.stages.map((s) => ({ label: s.stage, value: s.players }))} empty="Nobody is in the game right now" />
            </Panel>
            <Panel title="Time in the current session">
              <CategoryBars data={data.currentSessionLengths} xKey="bucket" yKey="sessions" label="Sessions" />
            </Panel>
            <Panel title="Regions" subtitle="Country Roblox reports for each live player">
              <BarList items={data.regions.map((r) => ({ label: COUNTRY(r.country), value: r.players }))} empty="Nobody is in the game right now" />
            </Panel>
            <Panel title="Concurrent players, 24 hours" subtitle="5-minute peaks">
              <TimeChart data={data.ccu24h} granularity="hour" tz={tz} kind="area" defs={[{ key: "ccu", label: "Players" }]} />
            </Panel>
          </div>
          <Panel className="mt-4" title="Servers" subtitle={`${data.serverList.length} running`}>
            <Table
              rows={data.serverList as unknown as Record<string, unknown>[]}
              empty="No game servers are running"
              columns={[
                { key: "serverId", label: "Server", render: (r) => <span className="font-medium text-ink" title={String(r.serverId)}>{String(r.serverId).slice(0, 8)}</span> },
                { key: "kind", label: "Type" },
                { key: "placeVersion", label: "Version", align: "right" },
                { key: "players", label: "Players", align: "right" },
                { key: "fps", label: "Server FPS", align: "right", render: (r) => fmtDec(r.fps as number | null, 0) },
                { key: "memoryMb", label: "Memory", align: "right", render: (r) => (r.memoryMb === null ? "—" : `${fmtInt(r.memoryMb as number)} MB`) },
                { key: "uptimeSec", label: "Uptime", align: "right", render: (r) => fmtDuration(r.uptimeSec as number | null) },
                { key: "lastHeartbeatAt", label: "Last heartbeat", align: "right", render: (r) => ago(String(r.lastHeartbeatAt), now) },
              ]}
            />
          </Panel>
        </>
      )}
    </>
  );
}
