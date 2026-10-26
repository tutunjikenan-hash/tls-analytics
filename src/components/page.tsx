"use client";

import { Download, RefreshCw } from "lucide-react";
import { ago } from "@/lib/format";
import { useNow, useRangeState } from "@/lib/client";
import { Empty, Skeleton } from "./ui/primitives";

export interface Freshness {
  lastEventAt: string | null;
  rollupsAt: string | null;
}

export function PageHeader({ title, description, range, freshness, generatedAt, exportDataset, children }: {
  title: string;
  description?: string;
  range?: { label: string; tz: string; complete: boolean };
  freshness?: Freshness;
  generatedAt?: string;
  exportDataset?: string;
  children?: React.ReactNode;
}) {
  const now = useNow(5000);
  const { query } = useRangeState();
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.02em] text-ink">{title}</h1>
        <p className="mt-0.5 text-[13px] text-ink-3">
          {description}
          {range && <>{description ? " " : ""}{range.label}{range.complete ? "" : " so far"}, {range.tz}.</>}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-3">
        {children}
        {generatedAt && (
          <span className="inline-flex items-center gap-1.5" title={freshness?.rollupsAt ? `Charts recomputed ${ago(freshness.rollupsAt, now)}` : undefined}>
            <RefreshCw className="h-3 w-3" aria-hidden /> Updated {ago(generatedAt, now)}
            {freshness && <> · last event {ago(freshness.lastEventAt, now)}</>}
          </span>
        )}
        {exportDataset && (
          <a className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface-2 px-3 text-[13px] text-ink hover:bg-surface-3" href={`/api/export/${exportDataset}.csv?${query}`}>
            <Download className="h-3.5 w-3.5" /> CSV
          </a>
        )}
      </div>
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="h-8 w-56" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-[104px]" />)}</div>
      <Skeleton className="h-[300px]" />
    </div>
  );
}

export function LoadError({ error }: { error: Error }) {
  return (
    <div className="rounded-xl border border-critical/40 bg-critical/5">
      <Empty title="This page could not load">{error.message}. It retries automatically.</Empty>
    </div>
  );
}

export function NoDataYet({ env }: { env: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface-1/50">
      <Empty title={env === "production" ? "No data from the game yet" : `No ${env} data yet`}>
        {env === "production" ? (
          <>Numbers appear here within seconds of the first player joining once the TLSAnalytics scripts are installed and the game is published with HTTP requests enabled. See docs/STUDIO_INSTALL.md.</>
        ) : env === "simulation" ? (
          <>Run <code className="text-ink-2">npm run simulate</code> to send simulated players into this separate environment.</>
        ) : (
          <>Play-test in Roblox Studio with the analytics scripts installed; Studio sessions are stored here, separately from production.</>
        )}
      </Empty>
    </div>
  );
}
