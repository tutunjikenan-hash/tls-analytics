"use client";

import { BarList, TimeChart } from "@/components/charts/charts";
import { Kpi } from "@/components/kpi";
import { LoadError, Loading, NoDataYet, PageHeader } from "@/components/page";
import { Panel, Table } from "@/components/ui/primitives";
import { useMetrics } from "@/lib/client";
import { fmtDateTime, fmtDuration, fmtInt, fmtPct } from "@/lib/format";
import type { serversPage } from "@/server/metrics/servers";

type Data = Awaited<ReturnType<typeof serversPage>>;

export default function ServersPage() {
  const { data, error } = useMetrics<Data>("servers");
  if (error && !data) return <LoadError error={error} />;
  if (!data) return <Loading />;
  const tz = data.range.tz;
  const t = data.ingestion.totals as Record<string, number>;
  return (
    <>
      <PageHeader title="Server health" range={data.range} freshness={data.freshness} generatedAt={data.generatedAt} />
      {!data.hasData ? (
        <NoDataYet env={data.env} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Servers started" value={fmtInt(data.started)} />
            <Kpi label="Running" value={fmtInt(data.running)} />
            <Kpi label="Shut down normally" value={fmtInt(data.shutdown)} />
            <Kpi label="Stopped responding" value={fmtInt(data.lost)} hint="No heartbeat within the session timeout and no shutdown message: a crash, a freeze or a network cut." sub={data.lostPct !== null ? `${fmtPct(data.lostPct)} of servers` : undefined} />
            <Kpi label="Average lifetime" value={fmtDuration(data.avgLifetimeSec)} />
            <Kpi label="Events received" value={fmtInt(t.accepted)} sub={`${fmtInt(t.duplicates)} duplicates, ${fmtInt(t.rejected)} rejected`} hint="Duplicates are retries the backend recognised and ignored. Rejected events failed validation." />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Server frame rate" subtitle={`Average and lowest, ${data.performance.bucketMin}-minute buckets, up to 24 h`}>
              <TimeChart data={data.performance.points} granularity="minute" tz={tz} defs={[{ key: "fps", label: "Average FPS", format: (v) => (v === null ? "no data" : v.toFixed(0)) }, { key: "minFps", label: "Lowest FPS", format: (v) => (v === null ? "no data" : v.toFixed(0)) }]} />
            </Panel>
            <Panel title="Server memory" subtitle="Average MB">
              <TimeChart data={data.performance.points} granularity="minute" tz={tz} kind="area" defs={[{ key: "memoryMb", label: "Memory", format: (v) => (v === null ? "no data" : `${v.toFixed(0)} MB`) }]} />
            </Panel>
            <Panel title="Ingestion, last hour" subtitle="Requests from game servers per minute">
              <TimeChart data={data.ingestion.lastHour} granularity="minute" tz={tz} kind="bar" defs={[{ key: "requests", label: "Requests" }]} />
            </Panel>
            <Panel title="Live servers by place version">
              <BarList items={data.liveVersions.map((v) => ({ label: `Version ${v.placeVersion}`, value: v.servers }))} empty="No servers are running" />
            </Panel>
          </div>
          <Panel className="mt-4" title="Recent servers that stopped responding">
            <Table
              rows={data.recentLost as unknown as Record<string, unknown>[]}
              empty="None. Every server has shut down cleanly."
              columns={[
                { key: "serverId", label: "Server", render: (x) => String(x.serverId).slice(0, 8) },
                { key: "placeVersion", label: "Version", align: "right" },
                { key: "startedAt", label: "Started", render: (x) => fmtDateTime(String(x.startedAt), tz) },
                { key: "lostAt", label: "Last heartbeat", render: (x) => fmtDateTime(String(x.lostAt), tz) },
              ]}
            />
          </Panel>
        </>
      )}
    </>
  );
}
