"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { LoadError, Loading, PageHeader } from "@/components/page";
import { Badge, Button, Empty, Input, Panel, Select, Switch, Table } from "@/components/ui/primitives";
import { api, useMe, type Me } from "@/lib/client";
import { ago, fmtDateTime } from "@/lib/format";
import type { AppSettings } from "@/server/settings";

interface SettingsData {
  settings: AppSettings;
  jobs: Array<{ name: string; last_run_at: string | null; last_ok_at: string | null; last_error: string | null }>;
  config: { discordWebhook: boolean; robloxUniverseId: number | null; jobsEnabled: boolean; ingestUrl: string };
}

const TABS = [
  { id: "general", label: "General", perm: "view" },
  { id: "keys", label: "Game server keys", perm: "manage_keys" },
  { id: "users", label: "Users", perm: "manage_users" },
  { id: "reconcile", label: "Reconcile revenue", perm: "reconcile" },
  { id: "jobs", label: "Background jobs", perm: "view" },
  { id: "audit", label: "Audit log", perm: "view_audit" },
];

export default function SettingsPage() {
  const { data: me } = useMe();
  const { data, error, mutate } = useSWR<SettingsData>("/api/settings", (u: string) => api<SettingsData>(u), { refreshInterval: 30_000 });
  if (error && !data) return <LoadError error={error} />;
  if (!data || !me) return <Loading />;
  const tabs = TABS.filter((t) => me.permissions.includes(t.perm));
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs.Root defaultValue="general">
        <Tabs.List className="mb-4 flex flex-wrap gap-1 border-b border-line" aria-label="Settings sections">
          {tabs.map((t) => (
            <Tabs.Trigger key={t.id} value={t.id} className="-mb-px border-b-2 border-transparent px-3 pb-2 text-[14px] text-ink-2 hover:text-ink data-[state=active]:border-sodium data-[state=active]:text-ink">
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="general"><General data={data} me={me} onSaved={() => mutate()} /></Tabs.Content>
        <Tabs.Content value="keys"><Keys ingestUrl={data.config.ingestUrl} /></Tabs.Content>
        <Tabs.Content value="users"><Users /></Tabs.Content>
        <Tabs.Content value="reconcile"><Reconcile /></Tabs.Content>
        <Tabs.Content value="jobs"><Jobs data={data} /></Tabs.Content>
        <Tabs.Content value="audit"><Audit /></Tabs.Content>
      </Tabs.Root>
    </>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 py-3 md:grid-cols-[260px_1fr] md:gap-6">
      <div>
        <div className="text-[14px] text-ink">{label}</div>
        {help && <div className="mt-0.5 text-[12px] leading-[18px] text-ink-3">{help}</div>}
      </div>
      <div className="max-w-[420px]">{children}</div>
    </div>
  );
}

function General({ data, me, onSaved }: { data: SettingsData; me: Me; onSaved: () => void }) {
  const s = data.settings;
  const can = me.permissions.includes("manage_settings");
  const [form, setForm] = useState({
    reporting_timezone: s.reporting_timezone,
    session_timeout_seconds: s.session_timeout_seconds,
    creator_share: s.creator_share,
    raw_event_retention_days: s.raw_event_retention_days,
    heartbeat_retention_days: s.heartbeat_retention_days,
    gameplay_funnel: s.gameplay_funnel.join(", "),
    daily_report_hour: s.daily_report_hour,
    reports_enabled: s.reports_enabled,
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [manual, setManual] = useState({ metric: "visits", value: "", asOf: new Date().toISOString().slice(0, 16) });
  // the browser's list omits aliases such as "UTC": always offer UTC and the current setting
  const zones = [...new Set([s.reporting_timezone, "UTC", ...(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [])])];
  const save = async () => {
    setMsg(null);
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          ...form,
          session_timeout_seconds: Number(form.session_timeout_seconds),
          creator_share: Number(form.creator_share),
          raw_event_retention_days: Number(form.raw_event_retention_days),
          heartbeat_retention_days: Number(form.heartbeat_retention_days),
          daily_report_hour: Number(form.daily_report_hour),
          gameplay_funnel: form.gameplay_funnel.split(",").map((x) => x.trim()).filter(Boolean),
        }),
      });
      setMsg(form.reporting_timezone !== s.reporting_timezone ? "Saved. Day-based charts are being rebuilt in the new time zone (about a minute)." : "Saved.");
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="grid gap-4">
      <Panel title="Reporting" subtitle={can ? undefined : "Only admins can change settings."}>
        <div className="divide-y divide-line">
          <Field label="Reporting time zone" help="Where days start and end for every daily number, chart and retention cohort. Changing it rebuilds daily data.">
            <Select label="Time zone" value={form.reporting_timezone} onValueChange={(v) => setForm({ ...form, reporting_timezone: v })} options={zones.map((z) => ({ value: z, label: z }))} className="w-full justify-between" />
          </Field>
          <Field label="Session timeout, seconds" help="A player whose server stops reporting them for this long is no longer live. Game servers report every 10 s.">
            <Input type="number" min={25} max={300} value={form.session_timeout_seconds} disabled={!can} onChange={(e) => setForm({ ...form, session_timeout_seconds: Number(e.target.value) })} />
          </Field>
          <Field label="Creator share" help="Used only for the estimated earnings figure (0.7 = 70%). Verified earnings come from reconciliation.">
            <Input type="number" step="0.01" min={0} max={1} value={form.creator_share} disabled={!can} onChange={(e) => setForm({ ...form, creator_share: Number(e.target.value) })} />
          </Field>
          <Field label="Gameplay funnel" help="Event names in order, comma separated (2 to 8 steps).">
            <Input value={form.gameplay_funnel} disabled={!can} onChange={(e) => setForm({ ...form, gameplay_funnel: e.target.value })} />
          </Field>
        </div>
      </Panel>
      <Panel title="Reports" subtitle={data.config.discordWebhook ? "Posted to the Discord webhook." : "Set DISCORD_WEBHOOK_URL on the server to receive reports."}>
        <div className="divide-y divide-line">
          <Field label="Daily and weekly reports" help="Daily report for yesterday; on Mondays also the last 7 days.">
            <Switch label="Reports enabled" checked={form.reports_enabled} disabled={!can} onCheckedChange={(v) => setForm({ ...form, reports_enabled: v })} />
          </Field>
          <Field label="Send at hour" help="Local hour in the reporting time zone (0-23).">
            <Input type="number" min={0} max={23} value={form.daily_report_hour} disabled={!can} onChange={(e) => setForm({ ...form, daily_report_hour: Number(e.target.value) })} />
          </Field>
        </div>
      </Panel>
      <Panel title="Data retention" subtitle="Aggregates (daily stats, sessions, purchases, retention) are kept indefinitely.">
        <div className="divide-y divide-line">
          <Field label="Raw events, days" help="The original event log, for audits and debugging. At least 8 (needed to recognise retried events).">
            <Input type="number" min={8} value={form.raw_event_retention_days} disabled={!can} onChange={(e) => setForm({ ...form, raw_event_retention_days: Number(e.target.value) })} />
          </Field>
          <Field label="Server heartbeats, days" help="Per-server FPS and memory samples.">
            <Input type="number" min={1} value={form.heartbeat_retention_days} disabled={!can} onChange={(e) => setForm({ ...form, heartbeat_retention_days: Number(e.target.value) })} />
          </Field>
        </div>
      </Panel>
      {can && (
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={save}>Save settings</Button>
          {msg && <span className="text-[13px] text-ink-2">{msg}</span>}
        </div>
      )}
      {can && (
        <Panel title="Add a Roblox-reported number" subtitle="For example your lifetime visits before tracking began, copied from the experience page or Creator Dashboard. Shown separately and labelled as entered by hand.">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/api/roblox-reported", { method: "POST", body: JSON.stringify({ metric: manual.metric, value: Number(manual.value), asOf: new Date(manual.asOf).toISOString() }) });
                setManual({ ...manual, value: "" });
                setMsg("Roblox-reported number saved.");
              } catch (err) {
                setMsg((err as Error).message);
              }
            }}
          >
            <Select label="Metric" value={manual.metric} onValueChange={(v) => setManual({ ...manual, metric: v })} options={[{ value: "visits", label: "Lifetime visits" }, { value: "favorites", label: "Favorites" }, { value: "lifetime_revenue_robux", label: "Lifetime revenue (R$)" }, { value: "premium_payouts_robux", label: "Premium Payouts (R$)" }]} />
            <Input className="w-40" type="number" min={0} placeholder="Value" value={manual.value} onChange={(e) => setManual({ ...manual, value: e.target.value })} required />
            <Input className="w-56" type="datetime-local" value={manual.asOf} onChange={(e) => setManual({ ...manual, asOf: e.target.value })} required />
            <Button type="submit">Add number</Button>
          </form>
        </Panel>
      )}
    </div>
  );
}

interface KeyRow { id: string; name: string; key_prefix: string; environments: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null }

function Keys({ ingestUrl }: { ingestUrl: string }) {
  const { data, mutate } = useSWR<{ keys: KeyRow[] }>("/api/keys", (u: string) => api<{ keys: KeyRow[] }>(u));
  const [name, setName] = useState("Production servers");
  const [envs, setEnvs] = useState<string[]>(["production", "studio"]);
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      <Panel title="Create a key" subtitle="Game servers send this key with every request. Store it as a Roblox secret (never in a script). It is shown once.">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              const r = await api<{ key: string }>("/api/keys", { method: "POST", body: JSON.stringify({ name, environments: envs }) });
              setCreated(r.key);
              await mutate();
            } catch (x) {
              setErr((x as Error).message);
            }
          }}
        >
          <div className="flex flex-wrap items-center gap-3">
            <Input className="w-64" value={name} onChange={(e) => setName(e.target.value)} aria-label="Key name" required />
            {["production", "studio", "simulation"].map((v) => (
              <label key={v} className="inline-flex items-center gap-2 text-[13px] text-ink-2">
                <Switch label={`Allow ${v}`} checked={envs.includes(v)} onCheckedChange={(on) => setEnvs(on ? [...envs, v] : envs.filter((x) => x !== v))} /> {v}
              </label>
            ))}
            <Button type="submit" variant="primary" disabled={!envs.length}><KeyRound className="h-3.5 w-3.5" /> Create key</Button>
          </div>
          {err && <p className="text-[13px] text-[#f0a3a3]">{err}</p>}
        </form>
        {created && (
          <div className="mt-4 rounded-lg border border-sodium/40 bg-sodium-dim p-4">
            <p className="text-[13px] text-ink">Copy this key now. It will not be shown again.</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md bg-night px-3 py-2 text-[13px] text-ink">{created}</code>
              <Button size="sm" onClick={() => navigator.clipboard.writeText(created)}><Copy className="h-3.5 w-3.5" /> Copy</Button>
            </div>
            <p className="mt-2 text-[12px] text-ink-3">In Creator Hub: your experience → Secrets → add a secret named <code>tls_analytics_key</code> with this value and domain <code>{new URL(ingestUrl).host}</code>. Endpoint: <code>{ingestUrl}</code></p>
          </div>
        )}
      </Panel>
      <Panel title="Keys">
        <Table
          rows={(data?.keys ?? []) as unknown as Record<string, unknown>[]}
          empty="No keys yet"
          columns={[
            { key: "name", label: "Name", render: (k) => <span className="text-ink">{String(k.name)}</span> },
            { key: "key_prefix", label: "Starts with", render: (k) => <code>{String(k.key_prefix)}…</code> },
            { key: "environments", label: "Environments", render: (k) => (k.environments as string[]).join(", ") },
            { key: "last_used_at", label: "Last used", render: (k) => ago(k.last_used_at as string | null) },
            {
              key: "id", label: "", align: "right",
              render: (k) => k.revoked_at ? <Badge>Revoked</Badge> : (
                <Button size="sm" variant="danger" onClick={async () => { if (window.confirm?.(`Revoke "${k.name}"? Servers using it stop sending within 30 seconds.`) !== false) { await api(`/api/keys/${k.id}`, { method: "DELETE" }); await mutate(); } }}>Revoke</Button>
              ),
            },
          ]}
        />
      </Panel>
    </div>
  );
}

interface UserRow { id: string; email: string; name: string; role: string; last_login_at: string | null; disabled_at: string | null; locked_until: string | null }

function Users() {
  const { data, mutate } = useSWR<{ users: UserRow[] }>("/api/users", (u: string) => api<{ users: UserRow[] }>(u));
  const [f, setF] = useState({ email: "", name: "", role: "viewer", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const patch = async (id: string, body: Record<string, unknown>) => {
    setErr(null);
    try {
      await api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      await mutate();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <div className="grid gap-4">
      <Panel title="Add a user" subtitle="Viewer: dashboards without revenue. Analyst: plus revenue and CSV exports. Admin: plus settings, keys, alerts, reconciliation. Owner: plus users.">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await api("/api/users", { method: "POST", body: JSON.stringify(f) });
              setF({ email: "", name: "", role: "viewer", password: "" });
              await mutate();
            } catch (x) {
              setErr((x as Error).message);
            }
          }}
        >
          <Input className="w-48" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <Input className="w-56" type="email" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          <Select label="Role" value={f.role} onValueChange={(v) => setF({ ...f, role: v })} options={["viewer", "analyst", "admin", "owner"].map((r) => ({ value: r, label: r }))} />
          <Input className="w-56" type="password" placeholder="Temporary password (12+ characters)" minLength={12} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
          <Button type="submit" variant="primary">Add user</Button>
        </form>
        {err && <p className="mt-2 text-[13px] text-[#f0a3a3]">{err}</p>}
      </Panel>
      <Panel title="Users">
        <Table
          rows={(data?.users ?? []) as unknown as Record<string, unknown>[]}
          columns={[
            { key: "name", label: "Name", render: (u) => <span className="text-ink">{String(u.name)}</span> },
            { key: "email", label: "Email" },
            { key: "role", label: "Role", render: (u) => <Select label="Role" value={String(u.role)} onValueChange={(v) => patch(String(u.id), { role: v })} options={["viewer", "analyst", "admin", "owner"].map((r) => ({ value: r, label: r }))} /> },
            { key: "last_login_at", label: "Last sign-in", render: (u) => ago(u.last_login_at as string | null) },
            {
              key: "id", label: "", align: "right",
              render: (u) => (
                <div className="flex justify-end gap-2">
                  {Boolean(u.locked_until) && new Date(String(u.locked_until)) > new Date() && <Button size="sm" onClick={() => patch(String(u.id), { unlock: true })}>Unlock</Button>}
                  {u.disabled_at ? <Button size="sm" onClick={() => patch(String(u.id), { disabled: false })}>Enable</Button> : <Button size="sm" variant="danger" onClick={() => patch(String(u.id), { disabled: true })}>Disable</Button>}
                </div>
              ),
            },
          ]}
        />
      </Panel>
    </div>
  );
}

function Reconcile() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const run = async (dryRun: boolean) => {
    const rows = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^purchase/i.test(l)).map((l) => {
      const [purchaseId, verified, refunded] = l.split(/[,\t;]/).map((x) => x.trim());
      return { purchaseId, ...(verified ? { verifiedCreatorRobux: Number(verified) } : {}), ...(refunded ? { refunded: /^(1|true|yes|refunded)$/i.test(refunded) } : {}) };
    });
    try {
      const r = await api<{ matched: number; unmatched: string[] }>("/api/revenue/reconcile", { method: "POST", body: JSON.stringify({ rows, dryRun }) });
      setResult(`${dryRun ? "Check: " : "Applied: "}${r.matched} of ${rows.length} rows match a recorded purchase.${r.unmatched.length ? ` Not found: ${r.unmatched.slice(0, 10).join(", ")}${r.unmatched.length > 10 ? "…" : ""}` : ""}`);
    } catch (x) {
      setResult((x as Error).message);
    }
  };
  return (
    <Panel title="Reconcile with official Roblox records" subtitle="Paste one purchase per line: purchase id, verified creator Robux, refunded (optional). Take the values from your Creator Hub sales export. Rows that match no recorded purchase are listed, never guessed.">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={"purchaseId,verifiedCreatorRobux,refunded\n1a2b3c...,70,\n9f8e7d...,,true"} className="w-full rounded-lg border border-line-strong bg-surface-2 p-3 font-[inherit] text-[13px] text-ink placeholder:text-ink-3 focus:border-sodium focus:outline-none" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => run(true)} disabled={!text.trim()}>Check rows</Button>
        <Button variant="primary" onClick={() => run(false)} disabled={!text.trim()}>Apply</Button>
        {result && <span className="text-[13px] text-ink-2">{result}</span>}
      </div>
    </Panel>
  );
}

function Jobs({ data }: { data: SettingsData }) {
  return (
    <Panel title="Background jobs" subtitle={data.config.jobsEnabled ? "Run by one app instance (leader election through Postgres)." : "JOBS_ENABLED=false on this instance."}>
      {data.jobs.length === 0 ? (
        <Empty title="No job has run yet">Jobs start a few seconds after the server boots.</Empty>
      ) : (
        <Table
          rows={data.jobs as unknown as Record<string, unknown>[]}
          columns={[
            { key: "name", label: "Job", render: (j) => <code className="text-ink">{String(j.name)}</code> },
            { key: "last_ok_at", label: "Last success", render: (j) => ago(j.last_ok_at as string | null) },
            { key: "last_run_at", label: "Last run", render: (j) => ago(j.last_run_at as string | null) },
            { key: "last_error", label: "Status", render: (j) => (j.last_error ? <Badge tone="critical">⚠ {String(j.last_error).slice(0, 80)}</Badge> : <Badge tone="good">✓ ok</Badge>) },
          ]}
        />
      )}
    </Panel>
  );
}

function Audit() {
  const { data } = useSWR<{ entries: Array<Record<string, unknown>> }>("/api/audit", (u: string) => api<{ entries: Array<Record<string, unknown>> }>(u));
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <Panel title="Audit log" subtitle="Sign-ins, setting changes, keys, users, exports and reconciliation. Latest 300.">
      <Table
        dense
        rows={data?.entries ?? []}
        columns={[
          { key: "at", label: "When", render: (e) => fmtDateTime(String(e.at), tz) },
          { key: "user_name", label: "Who", render: (e) => String(e.user_name ?? "—") },
          { key: "action", label: "Action", render: (e) => <code className="text-ink">{String(e.action)}</code> },
          { key: "target", label: "Target", render: (e) => String(e.target ?? "") },
        ]}
      />
    </Panel>
  );
}
