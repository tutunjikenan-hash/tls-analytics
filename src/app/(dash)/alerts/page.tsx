"use client";

import { AlertOctagon, AlertTriangle, Check, Info } from "lucide-react";
import useSWR from "swr";
import { PageHeader, LoadError, Loading } from "@/components/page";
import { Badge, Button, Empty, Input, Panel, Switch } from "@/components/ui/primitives";
import { api, useMe, useRangeState } from "@/lib/client";
import { fmtDateTime } from "@/lib/format";

interface Rule { kind: string; enabled: boolean; params: Record<string, number>; cooldown_min: number; severity: "info" | "warning" | "critical" }
interface Event { id: string; kind: string; severity: Rule["severity"]; title: string; fired_at: string; notified_at: string | null; notify_error: string | null; acknowledged_at: string | null; acknowledged_by: string | null }
interface Data { rules: Rule[]; events: Event[]; discordConfigured: boolean }

const RULES: Record<string, { name: string; params: Record<string, string> }> = {
  ccu_spike: { name: "CCU spike", params: { pct: "Rise, %", min_ccu: "Only above CCU", window_min: "Baseline minutes" } },
  ccu_drop: { name: "CCU drop", params: { pct: "Fall, %", min_ccu: "Only when baseline is at least", window_min: "Baseline minutes" } },
  departure_surge: { name: "Players leaving", params: { multiplier: "× usual leaves per 5 min", min_leaves: "At least leaves" } },
  revenue_spike: { name: "Revenue spike", params: { multiplier: "× 7-day hourly average", min_robux: "At least Robux in an hour" } },
  purchase_errors: { name: "Purchase errors", params: { min_errors: "Errors in 15 min" } },
  server_failures: { name: "Servers stop responding", params: { min_lost: "Servers lost", window_min: "Within minutes" } },
  ingestion_outage: { name: "No data arriving", params: { silent_min: "Silent minutes" } },
  completion_rate_shift: { name: "Completion rate change", params: { pct_points: "Change, percentage points", min_runs: "Minimum runs each side" } },
};
const SEV = { info: { icon: Info, tone: "neutral" as const }, warning: { icon: AlertTriangle, tone: "warning" as const }, critical: { icon: AlertOctagon, tone: "critical" as const } };

export default function AlertsPage() {
  const { state } = useRangeState();
  const { data: me } = useMe();
  const { data, error, mutate } = useSWR<Data>(`/api/alerts?env=${state.env}`, (u: string) => api<Data>(u), { refreshInterval: 15_000 });
  if (error && !data) return <LoadError error={error} />;
  if (!data) return <Loading />;
  const canEdit = me?.permissions.includes("manage_alerts");
  const update = async (patch: Partial<Rule> & { kind: string }) => {
    await api("/api/alerts", { method: "PATCH", body: JSON.stringify(patch) });
    await mutate();
  };
  return (
    <>
      <PageHeader title="Alerts" description={data.discordConfigured ? "Alerts are posted to Discord." : "Discord is not configured (DISCORD_WEBHOOK_URL); alerts are only listed here."} />
      <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
        <Panel title="Recent alerts" subtitle={`${state.env} environment`}>
          {data.events.length === 0 ? (
            <Empty title="No alerts have fired">Rules are checked every minute against measured data.</Empty>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {data.events.map((e) => {
                const S = SEV[e.severity];
                return (
                  <li key={e.id} className="flex items-start gap-3 py-3">
                    <S.icon className={e.severity === "critical" ? "mt-0.5 h-4 w-4 text-critical" : e.severity === "warning" ? "mt-0.5 h-4 w-4 text-warning" : "mt-0.5 h-4 w-4 text-ink-3"} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] text-ink">{e.title}</div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-ink-3">
                        <span>{fmtDateTime(e.fired_at, Intl.DateTimeFormat().resolvedOptions().timeZone)}</span>
                        <span>{RULES[e.kind]?.name ?? e.kind}</span>
                        <Badge tone={S.tone}>{e.severity}</Badge>
                        {e.notify_error ? <span className="text-[#f0a3a3]">Discord: {e.notify_error}</span> : e.notified_at ? <span>sent to Discord</span> : null}
                        {e.acknowledged_at && <span>acknowledged{e.acknowledged_by ? ` by ${e.acknowledged_by}` : ""}</span>}
                      </div>
                    </div>
                    {!e.acknowledged_at && (
                      <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/alerts/${e.id}`, { method: "POST" }); await mutate(); }}>
                        <Check className="h-3.5 w-3.5" /> Acknowledge
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel title="Rules" subtitle={canEdit ? "Changes apply at the next check (within a minute)." : "Only admins can change rules."}>
          <ul className="flex flex-col gap-4">
            {data.rules.map((r) => (
              <li key={r.kind} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[14px] font-medium text-ink">{RULES[r.kind]?.name ?? r.kind}</span>
                  <Switch label={`Enable ${r.kind}`} checked={r.enabled} disabled={!canEdit} onCheckedChange={(v) => update({ kind: r.kind, enabled: v })} />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {Object.entries(RULES[r.kind]?.params ?? {}).map(([p, label]) => (
                    <label key={p} className="flex flex-col gap-1 text-[12px] text-ink-3">
                      {label}
                      <Input
                        type="number"
                        min={0}
                        defaultValue={r.params[p]}
                        disabled={!canEdit}
                        className="h-8"
                        onBlur={(ev) => {
                          const v = Number(ev.target.value);
                          if (Number.isFinite(v) && v !== r.params[p]) void update({ kind: r.kind, params: { [p]: v } });
                        }}
                      />
                    </label>
                  ))}
                  <label className="flex flex-col gap-1 text-[12px] text-ink-3">
                    Quiet period after firing, min
                    <Input type="number" min={1} defaultValue={r.cooldown_min} disabled={!canEdit} className="h-8" onBlur={(ev) => { const v = Number(ev.target.value); if (v >= 1 && v !== r.cooldown_min) void update({ kind: r.kind, cooldown_min: v }); }} />
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
