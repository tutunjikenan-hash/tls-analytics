"use client";

import * as Popover from "@radix-ui/react-popover";
import { Activity, BarChart3, Bell, CalendarRange, Coins, Gamepad2, Gauge, LogOut, Menu, Repeat, Server, Settings, TrendingUp, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ago, fmtInt } from "@/lib/format";
import { api, useLiveStream, useNow, useRangeState, type Env, type Preset } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Button, Input, Select } from "./ui/primitives";

export interface ShellUser {
  name: string;
  email: string;
  role: "viewer" | "analyst" | "admin" | "owner";
}

const NAV = [
  { href: "/", label: "Overview", icon: Gauge },
  { href: "/live", label: "Live players", icon: Activity },
  { href: "/growth", label: "Player growth", icon: TrendingUp },
  { href: "/engagement", label: "Engagement & playtime", icon: BarChart3 },
  { href: "/retention", label: "Retention", icon: Repeat },
  { href: "/revenue", label: "Revenue", icon: Coins, minRole: "analyst" as const },
  { href: "/gameplay", label: "Gameplay", icon: Gamepad2 },
  { href: "/servers", label: "Server health", icon: Server },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/settings", label: "Settings", icon: Settings },
];
const RANK = { viewer: 0, analyst: 1, admin: 2, owner: 3 };

export function Shell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-dvh">
      <aside className={cn("fixed inset-y-0 left-0 z-40 flex w-[236px] flex-col border-r border-line bg-night transition-transform lg:translate-x-0", open ? "translate-x-0" : "-translate-x-full")}>
        <div className="flex h-14 items-center justify-between px-5">
          <Link href="/" className="flex items-baseline gap-2" onClick={() => setOpen(false)}>
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">The Last Shift</span>
            <span className="text-[12px] text-ink-3">analytics</span>
          </Link>
          <button className="rounded-md p-1 text-ink-3 lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu"><X className="h-4 w-4" /></button>
        </div>
        <Suspense>
          <Nav user={user} onNavigate={() => setOpen(false)} />
        </Suspense>
        <div className="border-t border-line px-4 py-3">
          <div className="truncate text-[13px] text-ink">{user.name}</div>
          <div className="flex items-center justify-between">
            <span className="text-[12px] capitalize text-ink-3">{user.role}</span>
            <button
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-ink-3 hover:bg-surface-2 hover:text-ink"
              onClick={async () => {
                await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
                window.location.href = "/login";
              }}
            >
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </div>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-[236px]">
        <Suspense>
          <TopBar onMenu={() => setOpen(true)} />
        </Suspense>
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 pb-16 pt-5 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

function Nav({ user, onNavigate }: { user: ShellUser; onNavigate: () => void }) {
  const path = usePathname();
  const sp = useSearchParams();
  // keep the range and environment when moving between pages
  const keep = new URLSearchParams();
  for (const k of ["range", "from", "to", "env"]) if (sp.get(k)) keep.set(k, sp.get(k)!);
  const qs = keep.toString() ? `?${keep}` : "";
  return (
    <nav className="flex-1 overflow-y-auto px-3 py-2" aria-label="Sections">
      {NAV.filter((n) => !n.minRole || RANK[user.role] >= RANK[n.minRole]).map((n) => {
        const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
        const Icon = n.icon;
        return (
          <Link
            key={n.href}
            href={`${n.href}${qs}`}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative mb-0.5 flex h-9 items-center gap-2.5 rounded-lg px-3 text-[14px] transition-colors",
              active ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-1 hover:text-ink",
            )}
          >
            {active && <span className="absolute left-0 top-2 h-5 w-[3px] rounded-full bg-sodium" aria-hidden />}
            <Icon className={cn("h-4 w-4", active ? "text-sodium" : "text-ink-3")} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: "live", label: "Live" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
  { value: "all", label: "All time" },
];

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { state, set } = useRangeState();
  const path = usePathname();
  const rangeless = path.startsWith("/live") || path.startsWith("/settings") || path.startsWith("/alerts");
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-night/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
        <button className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2 lg:hidden" onClick={onMenu} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
        {!rangeless && (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <div role="radiogroup" aria-label="Date range" className="flex max-w-full overflow-x-auto rounded-lg border border-line-strong bg-surface-1 p-0.5 [scrollbar-width:none]">
              {PRESETS.map((p) => (
                <button
                  key={p.value}
                  role="radio"
                  aria-checked={state.range === p.value}
                  onClick={() => set({ range: p.value })}
                  className={cn(
                    "h-7 shrink-0 whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors",
                    state.range === p.value ? "bg-surface-3 text-ink shadow-[inset_0_-2px_0_var(--color-sodium)]" : "text-ink-2 hover:text-ink",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <CustomRange active={state.range === "custom"} from={state.from} to={state.to} onApply={(from, to) => set({ range: "custom", from, to })} />
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select<Env>
            label="Environment"
            value={state.env}
            onValueChange={(env) => set({ env })}
            options={[
              { value: "production", label: "Production" },
              { value: "studio", label: "Studio tests" },
              { value: "simulation", label: "Simulation" },
            ]}
            className={state.env !== "production" ? "border-warning/60" : undefined}
          />
          <LiveStatus env={state.env} />
        </div>
      </div>
      {state.env !== "production" && (
        <div className="border-t border-warning/30 bg-warning/10 px-6 py-1.5 text-center text-[12px] text-[#fbd078]">
          You are looking at {state.env === "studio" ? "Studio test" : "simulated"} data. It is stored separately and never mixed into production.
        </div>
      )}
    </header>
  );
}

function CustomRange({ active, from, to, onApply }: { active: boolean; from?: string; to?: string; onApply: (from: string, to: string) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState(from ?? today);
  const [t, setT] = useState(to ?? today);
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px]", active ? "border-sodium/60 bg-surface-3 text-ink" : "border-line-strong bg-surface-1 text-ink-2 hover:text-ink")}>
          <CalendarRange className="h-3.5 w-3.5" />
          {active && from && to ? `${from} → ${to}` : "Custom"}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} align="start" className="z-50 w-[280px] rounded-xl border border-line-strong bg-surface-1 p-4 shadow-2xl shadow-black/50">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (f && t) {
                onApply(f, t);
                setOpen(false);
              }
            }}
          >
            <label className="flex flex-col gap-1 text-[12px] text-ink-3">First day<Input type="date" value={f} max={today} onChange={(e) => setF(e.target.value)} required /></label>
            <label className="flex flex-col gap-1 text-[12px] text-ink-3">Last day<Input type="date" value={t} max={today} onChange={(e) => setT(e.target.value)} required /></label>
            <p className="text-[12px] text-ink-3">Days are in the reporting time zone (Settings). Up to two years.</p>
            <Button variant="primary" type="submit">Show range</Button>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Live indicator: the SSE connection and how fresh the latest event from the game is. */
function LiveStatus({ env }: { env: Env }) {
  const { snap, connected } = useLiveStream(env);
  const now = useNow(5000);
  const lastMs = snap?.lastEventAt ? now - Date.parse(snap.lastEventAt) : null;
  const flowing = connected && lastMs !== null && lastMs < 60_000;
  const title = !connected ? "Not connected to the live stream — reconnecting" : snap?.lastEventAt ? `Last event from a game server ${ago(snap.lastEventAt, now)}` : "Connected — no events from game servers in the last day";
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg border border-line-strong bg-surface-1 px-2.5 text-[13px]" title={title}>
      <span className="live-dot" data-stale={!flowing} aria-hidden />
      <span className="num text-ink">{snap ? fmtInt(snap.ccu) : "—"}</span>
      <span className="hidden text-ink-3 sm:inline">{!connected ? "offline" : flowing ? "live" : snap?.lastEventAt ? ago(snap.lastEventAt, now) : "waiting"}</span>
    </div>
  );
}
