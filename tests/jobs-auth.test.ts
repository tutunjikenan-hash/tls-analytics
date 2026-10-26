import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { can, hashPassword, login, userFromToken } from "@/server/auth/auth";
import { pool } from "@/server/db";
import { evaluateAlerts } from "@/server/jobs/alerts";
import { reap } from "@/server/jobs/live";
import { rollupTick } from "@/server/jobs/runner";
import { takeToken, resetRateLimits } from "@/server/ingest/keys";
import { relinkTeleports } from "@/server/jobs/live";
import { rebuildAll } from "@/server/jobs/runner";
import { visits } from "@/server/metrics/core";
import { redactRevenue } from "@/server/redact";
import { ev, makeKey, min, resetDb, sec, send } from "./helpers";

const db = () => pool();

describe("alerts", () => {
  beforeEach(resetDb);

  it("server_failures fires once, then respects the cooldown", async () => {
    const key = await makeKey();
    const t = Date.parse("2026-10-20T12:00:00Z");
    await send([ev.hb(t, [])], { key, serverId: "a", now: t });
    await send([ev.hb(t, [])], { key, serverId: "b", now: t });
    const later = new Date(t + min(2));
    await reap(db(), 45, later);
    const f1 = await evaluateAlerts(db(), ["production"], later, false);
    expect(f1.map((f) => f.kind)).toContain("server_failures");
    const f2 = await evaluateAlerts(db(), ["production"], new Date(later.getTime() + min(1)), false);
    expect(f2.map((f) => f.kind)).not.toContain("server_failures");
    expect(Number((await db().query(`SELECT count(*) AS n FROM alert_events WHERE kind='server_failures'`)).rows[0].n)).toBe(1);
  });

  it("ccu_drop compares against the recent baseline and needs history", async () => {
    const now = new Date("2026-10-20T12:30:00Z");
    // no history: nothing fires
    expect((await evaluateAlerts(db(), ["production"], now, false)).length).toBe(0);
    for (let i = 12; i >= 3; i--) {
      await db().query(`INSERT INTO ccu_minutes (env, minute, peak_ccu, last_ccu, servers) VALUES ('production', date_trunc('minute', $1::timestamptz), 40, 40, 4)`, [new Date(now.getTime() - min(i))]);
    }
    await db().query(`INSERT INTO ccu_minutes (env, minute, peak_ccu, last_ccu, servers) VALUES ('production', date_trunc('minute', $1::timestamptz), 12, 12, 2)`, [new Date(now.getTime() - min(1))]);
    const fired = await evaluateAlerts(db(), ["production"], now, false);
    expect(fired.map((f) => f.kind)).toEqual(["ccu_drop"]);
  });

  it("an empty game is not an ingestion outage, a silent running game is", async () => {
    const key = await makeKey();
    const t = Date.parse("2026-10-20T12:00:00Z");
    await send([ev.stop(t)], { key, serverId: "x", now: t });
    // the only server shut down normally: silence after that is expected
    expect((await evaluateAlerts(db(), ["production"], new Date(t + min(20)), false)).map((f) => f.kind)).not.toContain("ingestion_outage");
    await send([ev.hb(t + min(21), [])], { key, serverId: "y", now: t + min(21), sentAt: t + min(21) });
    await db().query(`UPDATE raw_events SET received_at = $1`, [new Date(t + min(21))]);
    await reap(db(), 45, new Date(t + min(30)));
    const fired = await evaluateAlerts(db(), ["production"], new Date(t + min(30)), false);
    expect(fired.map((f) => f.kind)).toContain("ingestion_outage");
  });
});

describe("incremental rollups", () => {
  beforeEach(resetDb);

  it("a late event for an old hour is folded into that hour on the next tick", async () => {
    const key = await makeKey();
    const now = Date.now();
    const sid = randomUUID();
    await send([ev.start(sid, 1, now - min(5))], { key, now });
    await rollupTick(new Date(now));
    // a session from 3 hours ago arrives late (server reconnected)
    const old = now - 3 * 3600_000;
    const sid2 = randomUUID();
    await send([ev.start(sid2, 2, old), ev.end(sid2, 2, old + min(10))], { key, now: now + sec(30), sentAt: now + sec(30) });
    await rollupTick(new Date(now + min(2)));
    const hour = new Date(Math.floor(old / 3600_000) * 3600_000);
    const { rows } = await db().query(`SELECT visits FROM hourly_stats WHERE env='production' AND hour = $1`, [hour]);
    expect(rows[0]?.visits).toBe(1);
  });
});

describe("auth", () => {
  beforeEach(async () => {
    await resetDb();
    await db().query(`TRUNCATE users, user_sessions, audit_log CASCADE`);
    resetRateLimits();
  });

  it("logs in, rejects bad passwords, locks after 5 failures, and revokes", async () => {
    await db().query(`INSERT INTO users (email, name, role, password_hash) VALUES ('o@x.test','Owner','owner',$1)`, [await hashPassword("correct horse battery")]);
    const ok = await login("O@x.test", "correct horse battery", {});
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect((await userFromToken(ok.token))?.role).toBe("owner");
    const stored = (await db().query(`SELECT token_hash FROM user_sessions`)).rows[0].token_hash as Buffer;
    expect(stored.toString("utf8")).not.toContain(ok.token); // only the hash is stored
    for (let i = 0; i < 9; i++) expect(await login("o@x.test", "nope nope nope", {})).toEqual({ ok: false, reason: "invalid" });
    const tenth = await login("o@x.test", "nope nope nope", {});
    expect(tenth).toEqual({ ok: false, reason: "locked" });
    expect(await login("o@x.test", "correct horse battery", {})).toEqual({ ok: false, reason: "locked" });
    await db().query(`UPDATE user_sessions SET revoked_at = now()`);
    expect(await userFromToken(ok.token)).toBeNull();
    const actions = (await db().query(`SELECT action FROM audit_log`)).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["login", "login_failed", "login_blocked"]));
  }, 60_000);

  it("unknown emails fail the same way", async () => {
    expect(await login("ghost@x.test", "whatever whatever", {})).toEqual({ ok: false, reason: "invalid" });
  }, 30_000);

  it("role permissions", () => {
    expect(can("viewer", "view")).toBe(true);
    expect(can("viewer", "view_revenue")).toBe(false);
    expect(can("analyst", "export")).toBe(true);
    expect(can("analyst", "manage_keys")).toBe(false);
    expect(can("admin", "manage_keys")).toBe(true);
    expect(can("admin", "manage_users")).toBe(false);
    expect(can("owner", "manage_users")).toBe(true);
  });

  it("rate limiter survives a clock stepping backwards", () => {
    resetRateLimits();
    const t = 1_000_000_000;
    expect(takeToken("x", 5, t)).toBe(true);
    expect(takeToken("x", 5, t - 3600_000)).toBe(true);
  });
});

describe("review fixes", () => {
  beforeEach(resetDb);

  it("viewers never receive revenue fields, at any depth", () => {
    const out = redactRevenue({
      kpis: { visits: { value: 3 }, revenue: { value: 9 }, revenueToday: { value: 1 } },
      series: [{ t: "x", visits: 1, revenueRobux: 5, purchases: 2 }],
      byHourOfDay: [{ hour: 1, visits: 2, revenueRobux: 3 }],
      robloxReported: { visits: { value: 10 }, lifetime_revenue_robux: { value: 99 }, premium_payouts_robux: { value: 7 } },
    });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/revenue|robux|purchases/i);
    expect(out.kpis.visits.value).toBe(3);
    expect(out.robloxReported.visits.value).toBe(10);
  });

  it("a teleport that arrives before its lobby session is linked later", async () => {
    const key = await makeKey();
    const t = Date.parse("2026-10-20T12:00:00Z");
    const lobby = randomUUID(), shift = randomUUID();
    // the shift server's batch is committed first
    await send([ev.start(shift, 9, t + min(2), { teleportIn: true })], { key, serverId: "shift", now: t + min(3) });
    await send([ev.start(lobby, 9, t), ev.end(lobby, 9, t + min(2) - sec(10))], { key, serverId: "lobby", now: t + min(3) });
    const w = { from: new Date(t - 1), to: new Date(t + min(30)), fromDay: "", toDay: "" };
    expect(await visits(db(), "production", w)).toBe(2);
    const earliest = await relinkTeleports(db(), new Date(t + min(4)));
    expect(earliest?.getTime()).toBe(t + min(2));
    expect(await visits(db(), "production", w)).toBe(1);
  });

  it("a game-pass price that was 0 is corrected by a later report", async () => {
    const key = await makeKey();
    const t = Date.parse("2026-10-20T12:00:00Z");
    const gp = { purchaseId: "gp", kind: "game_pass", productId: 77, priceSource: "catalog_list_price" };
    await send([ev.purchase(4, t, { ...gp, robux: 0, status: "pending_verification" })], { key, now: t });
    await send([ev.purchase(4, t + 1000, { ...gp, robux: 199, status: "confirmed" })], { key, now: t + 1000 });
    const row = (await db().query(`SELECT robux_gross, status FROM purchases`)).rows[0];
    expect(row).toEqual({ robux_gross: 199, status: "confirmed" });
  });

  it("Studio test players (negative UserIds) are accepted", async () => {
    const key = await makeKey();
    const sid = randomUUID();
    const r = await send([ev.start(sid, -1, Date.now()), ev.hb(Date.now(), [{ sid, uid: -1 }])], { key, env: "studio", now: Date.now() });
    expect(r.body.rejected).toBe(0);
  });

  it("a refund applied by reconciliation reaches the daily aggregates after a rebuild", async () => {
    const key = await makeKey();
    const t = Date.now() - 6 * 86400_000;
    const sid = randomUUID();
    await send([ev.start(sid, 1, t), ev.purchase(1, t + 1000, { purchaseId: "r-9", kind: "developer_product", productId: 5, robux: 100, priceSource: "receipt_currency_spent", status: "confirmed" }), ev.end(sid, 1, t + min(5))], { key, now: Date.now() });
    await rebuildAll();
    const sum = async () => Number((await db().query(`SELECT COALESCE(sum(revenue_robux),0) AS r FROM daily_stats WHERE env='production'`)).rows[0].r);
    expect(await sum()).toBe(100);
    await db().query(`UPDATE purchases SET refunded_at = now()`);
    await rebuildAll();
    expect(await sum()).toBe(0);
  });
});
