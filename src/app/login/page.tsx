"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Button, Input } from "@/components/ui/primitives";

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const fd = new FormData(e.currentTarget);
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
        });
        const body = await res.json().catch(() => ({}));
        setBusy(false);
        if (!res.ok) {
          setError(body.error ?? "Sign-in failed");
          return;
        }
        const next = sp.get("next");
        router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
        router.refresh();
      }}
    >
      <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
        Email
        <Input name="email" type="email" autoComplete="username" required autoFocus />
      </label>
      <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
        Password
        <Input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && <p role="alert" className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-[13px] text-[#f0a3a3]">{error}</p>}
      <Button variant="primary" type="submit" disabled={busy} className="mt-1 h-10">{busy ? "Signing in…" : "Sign in"}</Button>
    </form>
  );
}

function SetupForm() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        if (fd.get("password") !== fd.get("confirm")) {
          setError("The two passwords don't match");
          return;
        }
        setBusy(true);
        setError(null);
        const res = await fetch("/api/auth/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: fd.get("name"), email: fd.get("email"), password: fd.get("password") }),
        });
        const body = await res.json().catch(() => ({}));
        setBusy(false);
        if (!res.ok) {
          setError(body.error ?? "Setup failed");
          return;
        }
        window.location.href = "/";
      }}
    >
      <p className="rounded-lg border border-sodium/40 bg-sodium-dim px-3 py-2 text-[13px] text-ink">First start: create the owner account. Use the owner email set on the server.</p>
      <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">Your name<Input name="name" autoComplete="name" required autoFocus /></label>
      <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">Email<Input name="email" type="email" autoComplete="username" required /></label>
      <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">Password (12+ characters)<Input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
      <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">Repeat password<Input name="confirm" type="password" autoComplete="new-password" minLength={12} required /></label>
      {error && <p role="alert" className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-[13px] text-[#f0a3a3]">{error}</p>}
      <Button variant="primary" type="submit" disabled={busy} className="mt-1 h-10">{busy ? "Creating…" : "Create owner account"}</Button>
    </form>
  );
}

function Gate() {
  const [setup, setSetup] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/auth/setup").then((r) => r.json()).then((j) => setSetup(!!j.needed)).catch(() => setSetup(false));
  }, []);
  if (setup === null) return <div className="h-40" aria-busy />;
  return setup ? <SetupForm /> : <LoginForm />;
}

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="canopy w-full max-w-[380px] rounded-2xl border border-line bg-surface-1 px-7 pb-7 pt-9">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">The Last Shift</h1>
        <p className="mb-7 mt-1 text-[14px] text-ink-3">Analytics. Sign in to see tonight&apos;s numbers.</p>
        <Suspense>
          <Gate />
        </Suspense>
      </div>
    </main>
  );
}
