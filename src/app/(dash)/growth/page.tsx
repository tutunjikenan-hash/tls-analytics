"use client";

import { BarList, TimeChart } from "@/components/charts/charts";
import { Delta, Kpi } from "@/components/kpi";
import { LoadError, Loading, NoDataYet, PageHeader } from "@/components/page";
import { Panel } from "@/components/ui/primitives";
import { useMetrics } from "@/lib/client";
import { COUNTRY, fmtInt, fmtPct } from "@/lib/format";
import type { growthPage } from "@/server/metrics/growth";

type Data = Awaited<ReturnType<typeof growthPage>>;

export default function GrowthPage() {
  const { data, error } = useMetrics<Data>("growth");
  if (error && !data) return <LoadError error={error} />;
  if (!data) return <Loading />;
  const tz = data.range.tz;
  const g = data.range.granularity;
  const share = data.shareLinkVisits;
  return (
    <>
      <PageHeader title="Player growth" range={data.range} freshness={data.freshness} generatedAt={data.generatedAt} exportDataset="daily" />
      {!data.hasData ? (
        <NoDataYet env={data.env} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="New players" value={fmtInt(data.newPlayers)} delta={data.newPlayersPrev !== null ? <Delta pct={data.newPlayersChangePct} /> : null} />
            <Kpi label="New share of active" value={fmtPct(data.newShareOfActivePct)} />
            <Kpi label="Players tracked" value={fmtInt(data.totalPlayersTracked)} hint="Distinct players seen since tracking began, up to the end of the range." />
            <Kpi label="Visits from share links" value={fmtInt(share.referred)} hint="Visits that started from a Roblox share link (join data ReferredByPlayerId)." sub={share.visits ? `${fmtPct((share.referred / share.visits) * 100)} of visits` : undefined} />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="New players" subtitle={g === "day" ? "Per day" : "Per hour"}>
              <TimeChart data={data.series} granularity={g} tz={tz} kind="bar" defs={[{ key: "newPlayers", label: "New players" }]} />
            </Panel>
            <Panel title="Players tracked, cumulative">
              <TimeChart data={data.cumulative} granularity={g} tz={tz} kind="area" defs={[{ key: "players", label: "Players" }]} />
            </Panel>
            <Panel title="Countries of new players">
              <BarList items={data.countriesOfNewPlayers.map((c) => ({ label: COUNTRY(c.country), value: c.players }))} empty="No new players in this range" />
            </Panel>
            <Panel title="Devices" subtitle="As reported by the game client; indicative only">
              <BarList items={data.devices.map((d) => ({ label: d.device, value: d.sessions }))} empty="The game does not send device counters yet" />
            </Panel>
          </div>
          <Panel className="mt-4" title="Not available here" subtitle="Roblox keeps these to itself. Use the Creator Dashboard for them.">
            <ul className="flex flex-col gap-3">
              {data.unavailable.map((u) => (
                <li key={u.metric} className="text-[13px]">
                  <div className="text-ink">{u.metric}</div>
                  <div className="text-ink-3">{u.why}</div>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </>
  );
}
