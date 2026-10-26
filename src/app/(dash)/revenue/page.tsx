"use client";

import { BarList, CategoryBars, TimeChart } from "@/components/charts/charts";
import { Delta, Kpi } from "@/components/kpi";
import { LoadError, Loading, NoDataYet, PageHeader } from "@/components/page";
import { Badge, Panel, Table } from "@/components/ui/primitives";
import { useMetrics } from "@/lib/client";
import { fmtDec, fmtInt, fmtPct, fmtRobux, fmtTime } from "@/lib/format";
import type { revenuePage } from "@/server/metrics/revenue";

type Data = Awaited<ReturnType<typeof revenuePage>>;

export default function RevenuePage() {
  const { data, error } = useMetrics<Data>("revenue");
  if (error && !data) return <LoadError error={error} />;
  if (!data) return <Loading />;
  const w = data.windows;
  const r = data.ratios;
  const tz = data.range.tz;
  const g = data.range.granularity;
  const share = Math.round(data.creatorShare * 100);
  return (
    <>
      <PageHeader title="Revenue" range={data.range} freshness={data.freshness} generatedAt={data.generatedAt} exportDataset="purchases" />
      {!data.hasData ? (
        <NoDataYet env={data.env} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi
              label={`Gross, ${data.range.label.toLowerCase()}`}
              size="lg"
              value={fmtRobux(w.selected.grossRobux)}
              hint="Robux buyers spent on confirmed purchases. Developer products use the amount on the receipt; game passes use the catalog price when the purchase was verified."
              delta={w.selected.previousGross !== null ? <Delta pct={w.selected.changePct} /> : null}
              sub={w.selected.previousGross !== null ? `prev ${fmtRobux(w.selected.previousGross)}` : undefined}
            />
            <Kpi label="Estimated creator earnings" value={fmtRobux(w.selected.estimatedCreatorRobux)} hint={`Gross × ${share}% (Settings). An estimate: Roblox's final amounts can differ (pending periods, refunds).`} sub={`${share}% of gross, estimate`} />
            <Kpi
              label="Verified earnings"
              value={w.selected.verifiedCreatorRobux === null ? "Not verified" : fmtRobux(w.selected.verifiedCreatorRobux)}
              hint="Only amounts confirmed against official Roblox reports (Settings → Reconcile). Empty until you reconcile."
              sub={`${fmtInt(data.reconciliation.reconciledPurchases)} of ${fmtInt(data.reconciliation.totalPurchases)} purchases reconciled`}
            />
            <Kpi label="Purchases" value={fmtInt(w.selected.purchases)} sub={`${fmtInt(w.selected.payingUsers)} paying players`} />
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {([
              ["Today", w.today.grossRobux],
              ["Yesterday", w.yesterday.grossRobux],
              ["7 days", w.d7.grossRobux],
              ["30 days", w.d30.grossRobux],
              ["90 days", w.d90.grossRobux],
              ["Lifetime, tracked", w.lifetime.grossRobux],
            ] as const).map(([label, v]) => (
              <div key={label} className="rounded-xl border border-line bg-surface-1 px-4 py-3">
                <div className="text-[12px] text-ink-3">{label}</div>
                <div className="num text-[18px] font-semibold text-ink">{fmtRobux(v)}</div>
              </div>
            ))}
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Kpi label="Payer conversion" value={fmtPct(r.conversionPct, 2)} hint="Paying players ÷ active players in the range." sub={r.conversionPctPrev !== null ? `prev ${fmtPct(r.conversionPctPrev, 2)}` : undefined} />
            <Kpi label="ARPDAU" value={r.arpdau === null ? "—" : `R$ ${fmtDec(r.arpdau, 2)}`} hint="Gross Robux ÷ sum of daily active players over the range." />
            <Kpi label="ARPPU" value={r.arppu === null ? "—" : `R$ ${fmtDec(r.arppu, 1)}`} hint="Gross Robux ÷ paying players." />
            <Kpi label="Purchases per payer" value={fmtDec(r.purchasesPerPayer, 2)} />
            <Kpi label="Prompt to purchase" value={fmtPct(r.promptConversionPct)} hint="Confirmed purchases ÷ purchase prompts the game showed (needs the purchase_prompt counter)." sub={r.prompts ? `${fmtInt(r.prompts)} prompts` : "prompts not tracked yet"} />
          </div>

          {(data.errors.receiptErrors > 0 || data.errors.notProcessedYet > 0 || w.selected.pendingPurchases > 0) && (
            <div className="mb-4 flex flex-wrap gap-2">
              {data.errors.receiptErrors > 0 && <Badge tone="critical">⚠ {data.errors.receiptErrors} receipt errors in this range</Badge>}
              {data.errors.notProcessedYet > 0 && <Badge tone="warning">⏳ {data.errors.notProcessedYet} receipts deferred (NotProcessedYet)</Badge>}
              {w.selected.pendingPurchases > 0 && <Badge tone="warning">⏳ {w.selected.pendingPurchases} game-pass purchases awaiting ownership check ({fmtRobux(w.selected.pendingRobux)}, not counted)</Badge>}
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Gross revenue" subtitle={g === "day" ? "Per day" : "Per hour"}>
              <TimeChart data={data.series} granularity={g} tz={tz} kind="bar" defs={[{ key: "revenueRobux", label: "Robux", format: fmtRobux }]} />
            </Panel>
            <Panel title="Last 30 days" subtitle="Per day, regardless of the selected range">
              <TimeChart data={data.last30Days} granularity="day" tz={tz} kind="bar" defs={[{ key: "revenueRobux", label: "Robux", format: fmtRobux }]} />
            </Panel>
            <Panel title="Top products">
              <BarList items={data.topProducts.slice(0, 10).map((p) => ({ label: p.name, sub: `${p.purchases}×`, value: p.grossRobux }))} format={fmtRobux} empty="No confirmed purchases in this range" />
            </Panel>
            <Panel title="Developer products and game passes">
              <div className="grid grid-cols-2 gap-4">
                {data.byKind.map((k) => (
                  <div key={k.kind} className="rounded-lg border border-line px-4 py-3">
                    <div className="text-[13px] text-ink-2">{k.kind === "game_pass" ? "Game passes" : "Developer products"}</div>
                    <div className="num mt-1 text-[22px] font-semibold text-ink">{fmtRobux(k.grossRobux)}</div>
                    <div className="text-[12px] text-ink-3">{fmtInt(k.purchases)} purchases · {fmtInt(k.payers)} payers</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[12px] leading-5 text-ink-3">Game-pass revenue uses the pass&apos;s catalog price; Roblox does not tell game servers the exact amount paid.</p>
            </Panel>
            <Panel title="By hour of day" subtitle={`Gross Robux, ${tz}`}>
              <CategoryBars data={data.byHourOfDay.map((h) => ({ ...h, label: String(h.hour).padStart(2, "0") }))} xKey="label" yKey="revenueRobux" label="Robux" format={fmtRobux} />
            </Panel>
            <Panel title="What this page does not measure">
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-5 text-ink-2">
                {data.notTracked.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </Panel>
          </div>

          <Panel className="mt-4" title="Recent purchases" subtitle="Latest 30, any date">
            <Table
              rows={data.recent as unknown as Record<string, unknown>[]}
              empty="No purchases recorded yet"
              columns={[
                { key: "at", label: "Time", render: (x) => fmtTime(String(x.at), tz, true) },
                { key: "productName", label: "Product", render: (x) => <span className="text-ink">{String(x.productName ?? `#${x.productId}`)}</span> },
                { key: "kind", label: "Type", render: (x) => (x.kind === "game_pass" ? "Game pass" : "Product") },
                { key: "player", label: "Player", render: (x) => <span title="Pseudonymous player key">{String(x.player)}</span> },
                { key: "robux", label: "Robux", align: "right", render: (x) => fmtRobux(Number(x.robux)) },
                {
                  key: "status", label: "Status", align: "right",
                  render: (x) => x.status === "confirmed" ? <Badge tone="good">✓ Confirmed</Badge> : x.status === "refunded" ? <Badge tone="serious">↩ Refunded</Badge> : <Badge tone="warning">⏳ Pending</Badge>,
                },
              ]}
            />
          </Panel>
        </>
      )}
    </>
  );
}
