"use client";

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "./ui/primitives";

/** Change vs the previous period. Shown only when there is a real base to compare with. */
export function Delta({ pct, invert = false, previous }: { pct: number | null | undefined; invert?: boolean; previous?: string }) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return <span className="text-[12px] text-ink-3">{previous === undefined ? "no comparison" : `prev ${previous}`}</span>;
  }
  const flat = Math.abs(pct) < 0.05;
  const up = pct > 0;
  const good = flat ? null : invert ? !up : up;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1 text-[12px]">
      <span className={cn("inline-flex items-center gap-0.5 font-medium", good === null ? "text-ink-2" : good ? "text-[#6fcf6f]" : "text-[#ef8f8f]")}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
        <span className="num">{flat ? "0%" : `${up ? "+" : ""}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`}</span>
      </span>
      {previous !== undefined && <span className="text-ink-3">vs {previous}</span>}
    </span>
  );
}

export function Kpi({ label, value, hint, delta, sub, size = "md", className }: {
  label: string;
  value: string;
  hint?: React.ReactNode;
  delta?: React.ReactNode;
  sub?: React.ReactNode;
  size?: "md" | "lg";
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl border border-line bg-surface-1 px-4 py-3.5", className)}>
      <div className="flex items-start gap-1.5 text-[13px] leading-[18px] text-ink-2">
        <span className="line-clamp-2 min-w-0">{label}</span>
        {hint && <Hint>{hint}</Hint>}
      </div>
      <div className={cn("num font-semibold tracking-[-0.02em] text-ink", size === "lg" ? "text-[28px] leading-9 sm:text-[34px] sm:leading-10" : "text-[22px] leading-8 sm:text-[24px]")}>{value}</div>
      <div className="flex min-h-4 flex-wrap items-center gap-x-2">{delta}{sub && <span className="text-[12px] text-ink-3">{sub}</span>}</div>
    </div>
  );
}
