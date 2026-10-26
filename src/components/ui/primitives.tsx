"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, ChevronDown, Info, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

/* ---------- Panel ---------------------------------------------------------------------------- */
export function Panel({ title, subtitle, actions, children, className, bodyClassName }: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-line bg-surface-1", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-5 pt-4">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold leading-6 text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] leading-5 text-ink-3">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("px-5 pb-5 pt-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/* ---------- Button --------------------------------------------------------------------------- */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap",
  {
    variants: {
      variant: {
        primary: "bg-sodium text-night hover:bg-[#f5b85a]",
        secondary: "border border-line-strong bg-surface-2 text-ink hover:bg-surface-3",
        ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
        danger: "border border-critical/50 bg-critical/10 text-[#f2a0a0] hover:bg-critical/20",
      },
      size: { sm: "h-8 px-3", md: "h-9 px-3.5", icon: "h-8 w-8" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);
export function Button({ className, variant, size, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...p} />;
}

/* ---------- Input ---------------------------------------------------------------------------- */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return (
    <input
      ref={ref}
      className={cn("h-9 w-full rounded-lg border border-line-strong bg-surface-2 px-3 text-[14px] text-ink placeholder:text-ink-3 focus:border-sodium focus:outline-none", className)}
      {...p}
    />
  );
});

/* ---------- Select (Radix) -------------------------------------------------------------------- */
export function Select<T extends string>({ value, onValueChange, options, className, label }: {
  value: T;
  onValueChange: (v: T) => void;
  options: Array<{ value: T; label: string; hint?: string }>;
  className?: string;
  label: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={(v) => onValueChange(v as T)}>
      <SelectPrimitive.Trigger aria-label={label} className={cn("inline-flex h-8 items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-3 text-[13px] text-ink hover:bg-surface-3", className)}>
        <SelectPrimitive.Value />
        <ChevronDown className="h-3.5 w-3.5 text-ink-3" />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={6} className="z-50 min-w-[--radix-select-trigger-width] overflow-hidden rounded-lg border border-line-strong bg-surface-2 p-1 shadow-xl shadow-black/40">
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item key={o.value} value={o.value} className="relative flex cursor-pointer select-none items-center rounded-md py-1.5 pl-7 pr-3 text-[13px] text-ink outline-none data-[highlighted]:bg-surface-3">
                <SelectPrimitive.ItemIndicator className="absolute left-2"><Check className="h-3.5 w-3.5 text-sodium" /></SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                {o.hint && <span className="ml-3 text-[12px] text-ink-3">{o.hint}</span>}
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

/* ---------- Switch --------------------------------------------------------------------------- */
export function Switch({ checked, onCheckedChange, label, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <SwitchPrimitive.Root
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className="relative h-5 w-9 shrink-0 rounded-full border border-line-strong bg-surface-3 transition-colors data-[state=checked]:border-sodium data-[state=checked]:bg-sodium/80 disabled:opacity-50"
    >
      <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-ink transition-transform data-[state=checked]:translate-x-[17px]" />
    </SwitchPrimitive.Root>
  );
}

/* ---------- Dialog --------------------------------------------------------------------------- */
export function Dialog({ open, onOpenChange, title, description, children }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed left-1/2 top-[12vh] z-50 max-h-[76vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-y-auto rounded-xl border border-line-strong bg-surface-1 p-6 shadow-2xl shadow-black/50">
          <DialogPrimitive.Title className="text-[17px] font-semibold text-ink">{title}</DialogPrimitive.Title>
          {description ? <DialogPrimitive.Description className="mt-1 text-[13px] text-ink-3">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
          <div className="mt-5">{children}</div>
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ---------- Hint (tooltip with the metric definition) ----------------------------------------- */
export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={150}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <button type="button" className="inline-flex text-ink-3 hover:text-ink-2" aria-label="How this is measured">
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content sideOffset={6} className="z-50 max-w-[280px] rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-[12px] leading-[18px] text-ink-2 shadow-xl shadow-black/40">
            {children}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/* ---------- Badge ---------------------------------------------------------------------------- */
export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "good" | "warning" | "serious" | "critical" | "sodium"; children: React.ReactNode; className?: string }) {
  const tones: Record<string, string> = {
    neutral: "border-line-strong text-ink-2",
    good: "border-good/40 text-[#7fd67f]",
    warning: "border-warning/40 text-[#fbd078]",
    serious: "border-serious/40 text-[#f3ae92]",
    critical: "border-critical/50 text-[#f0a3a3]",
    sodium: "border-sodium/40 text-sodium",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[12px] font-medium leading-4", tones[tone], className)}>{children}</span>;
}

/* ---------- Empty state ------------------------------------------------------------------------ */
export function Empty({ title, children, icon }: { title: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex min-h-[140px] flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      {icon && <div className="text-ink-3">{icon}</div>}
      <p className="text-[14px] font-medium text-ink-2">{title}</p>
      {children && <div className="max-w-[420px] text-[13px] leading-5 text-ink-3">{children}</div>}
    </div>
  );
}

/* ---------- Table ---------------------------------------------------------------------------- */
export function Table({ columns, rows, empty = "Nothing here yet", dense }: {
  columns: Array<{ key: string; label: string; align?: "left" | "right"; render?: (row: Record<string, unknown>) => React.ReactNode; className?: string }>;
  rows: Array<Record<string, unknown>>;
  empty?: string;
  dense?: boolean;
}) {
  if (!rows.length) return <Empty title={empty} />;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line text-ink-3">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn("px-5 pb-2 font-medium", c.align === "right" ? "text-right" : "text-left", c.className)}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="num">
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 last:border-0 hover:bg-surface-2/60">
              {columns.map((c) => (
                <td key={c.key} className={cn("px-5 text-ink-2", dense ? "py-1.5" : "py-2.5", c.align === "right" ? "text-right" : "text-left", c.className)}>
                  {c.render ? c.render(r) : (r[c.key] as React.ReactNode)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-2", className)} />;
}
