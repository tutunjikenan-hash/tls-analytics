"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";

export type Env = "production" | "studio" | "simulation";
export type Preset = "live" | "today" | "yesterday" | "7d" | "30d" | "90d" | "custom" | "all";

export interface RangeState {
  range: Preset;
  from?: string;
  to?: string;
  env: Env;
}

/** Range and environment live in the URL, so every view is shareable and survives reloads. */
export function useRangeState() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const state: RangeState = useMemo(
    () => ({
      range: (sp.get("range") as Preset) || "today",
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      env: (sp.get("env") as Env) || "production",
    }),
    [sp],
  );
  const set = useCallback(
    (patch: Partial<RangeState>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || v === "") next.delete(k);
        else next.set(k, String(v));
      }
      if (patch.range && patch.range !== "custom") {
        next.delete("from");
        next.delete("to");
      }
      if (next.get("env") === "production") next.delete("env");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [sp, router, pathname],
  );
  const query = useMemo(() => {
    const p = new URLSearchParams({ range: state.range, env: state.env });
    if (state.range === "custom" && state.from && state.to) {
      p.set("from", state.from);
      p.set("to", state.to);
    }
    return p.toString();
  }, [state]);
  return { state, set, query };
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `request failed (${res.status})`);
  return body as T;
}

/** Fetches a metrics page and keeps it fresh (live pages every 5 s, others every 30 s). */
export function useMetrics<T>(page: string, extra = "", opts: { refreshMs?: number } = {}) {
  const { query, state } = useRangeState();
  const refresh = opts.refreshMs ?? (state.range === "live" || state.range === "today" ? 10_000 : 30_000);
  const key = `/api/metrics/${page}?${query}${extra ? `&${extra}` : ""}`;
  const swr = useSWR<T>(key, (u: string) => api<T>(u), { refreshInterval: refresh, keepPreviousData: true, revalidateOnFocus: true });
  return { ...swr, key };
}

export interface LiveSnapshot {
  env: string;
  at: string;
  ccu: number;
  servers: number;
  sessions: number;
  joinsLastMin: number;
  leavesLastMin: number;
  robuxLastHour?: number;
  lastEventAt: string | null;
}

/** Server-Sent Events subscription; reconnects automatically (EventSource retry). */
export function useLiveStream(env: Env) {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  useEffect(() => {
    const es = new EventSource(`/api/live/stream?env=${env}`);
    esRef.current = es;
    es.addEventListener("live", (e) => {
      setSnap(JSON.parse((e as MessageEvent).data));
      setConnected(true);
    });
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);
    return () => es.close();
  }, [env]);
  return { snap, connected };
}

/** Re-renders every `ms` so "x seconds ago" labels stay honest. */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export interface Me {
  name: string;
  email: string;
  role: "viewer" | "analyst" | "admin" | "owner";
  permissions: string[];
}
export function useMe() {
  return useSWR<Me>("/api/auth/me", (u: string) => api<Me>(u), { revalidateOnFocus: false });
}
