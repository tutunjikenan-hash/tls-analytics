import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db";
import { rollupDays, rollupHours, rollupPlayerDays, rollupRetention, rebuildPlayerDays } from "@/server/jobs/rollups";
import { revenue, lifetimeRevenue } from "@/server/metrics/core";
import { resolveRange } from "@/server/metrics/range";
import { ev, makeKey, min, resetDb, send } from "./helpers";

const db = () => pool();
const D = (iso: string) => Date.parse(iso);
const dev = (id: string, robux: number, extra: Record<string, unknown> = {}) => ({
  purchaseId: id, kind: "developer_product", productId: 111, productName: "Flashlight Battery", robux, priceSource: "receipt_currency_spent", status: "confirmed", ...extra,
});

/** a closed session for uid from iso start, minutes long */
async function play(key: string, uid: number, iso: string, minutes: number) {
  const t = D(iso);
  const sid = randomUUID();
  await send([ev.start(sid, uid, t), ev.end(sid, uid, t + min(minutes))], { key, now: t + min(minutes), sentAt: t + min(minutes) });
}

describe("revenue", () => {
  beforeEach(resetDb);

  it("sums only confirmed purchases and separates gross from estimated creator earnings", async () => {
    const key = await makeKey();
    const t = D("2026-10-20T12:00:00Z");
    await send([
      ev.purchase(1, t, dev("rcpt-1", 100)),
      ev.purchase(2, t + 1000, dev("rcpt-2", 25)),
      ev.purchase(2, t + 2000, { purchaseId: "ignored", kind: "game_pass", productId: 999, productName: "VIP", robux: 400, priceSource: "catalog_list_price", status: "pending_verification" }),
    ], { key, now: t + 2000 });
    const w = { from: new Date(t - 1), to: new Date(t + min(1)), fromDay: "", toDay: "" };
    let r = await revenue(db(), "production", w);
    expect(r.grossRobux).toBe(125);
    expect(r.estimatedCreatorRobux).toBe(70 + 17); // floor(100*0.7) + floor(25*0.7)
    expect(r.verifiedCreatorRobux).toBeNull(); // nothing reconciled: never pretend
    expect(r.purchases).toBe(2);
    expect(r.payingUsers).toBe(2);
    expect(r.pendingPurchases).toBe(1);

    // game pass ownership verified later: same purchase (gp:<player>:<pass>), now confirmed
    await send([ev.purchase(2, t + 3000, { purchaseId: "x", kind: "game_pass", productId: 999, productName: "VIP", robux: 400, priceSource: "catalog_list_price", status: "confirmed" })], { key, now: t + 3000 });
    r = await revenue(db(), "production", w);
    expect(r.grossRobux).toBe(525);
    expect(r.pendingPurchases).toBe(0);
    expect((await lifetimeRevenue(db(), "production")).purchases).toBe(3);
  });

  it("a confirmed purchase is never downgraded by a late pending duplicate", async () => {
    const key = await makeKey();
    const t = D("2026-10-20T12:00:00Z");
    const gp = { purchaseId: "x", kind: "game_pass", productId: 5, robux: 50, priceSource: "catalog_list_price" };
    await send([ev.purchase(9, t, { ...gp, status: "confirmed" })], { key, now: t });
    await send([ev.purchase(9, t + 5, { ...gp, status: "pending_verification" })], { key, now: t });
    expect((await db().query(`SELECT status FROM purchases`)).rows[0].status).toBe("confirmed");
  });

  it("refunded purchases (set by reconciliation) drop out of revenue", async () => {
    const key = await makeKey();
    const t = D("2026-10-20T12:00:00Z");
    await send([ev.purchase(1, t, dev("rcpt-9", 80))], { key, now: t });
    await db().query(`UPDATE purchases SET refunded_at = now()`);
    expect((await revenue(db(), "production", { from: new Date(t - 1), to: new Date(t + 1), fromDay: "", toDay: "" })).grossRobux).toBe(0);
  });
});

describe("daily and hourly rollups", () => {
  beforeEach(resetDb);

  it("daily_stats matches the base tables and is idempotent", async () => {
    const key = await makeKey();
    await play(key, 1, "2026-10-20T10:00:00Z", 30);
    await play(key, 2, "2026-10-20T11:00:00Z", 10);
    await play(key, 1, "2026-10-20T15:00:00Z", 20); // returning same day
    await send([ev.purchase(1, D("2026-10-20T10:05:00Z"), dev("r-a", 100))], { key, now: D("2026-10-20T10:05:00Z") });
    await rollupPlayerDays(db(), "UTC", new Date(0));
    for (let i = 0; i < 2; i++) await rollupDays(db(), "UTC", "2026-10-19", "2026-10-21");
    const rows = (await db().query(`SELECT * FROM daily_stats WHERE env='production' ORDER BY day`)).rows;
    expect(rows).toHaveLength(1); // empty days are not written
    const d = rows[0];
    expect(d.visits).toBe(3);
    expect(d.dau).toBe(2);
    expect(d.new_players).toBe(2);
    expect(Number(d.playtime_sec)).toBe(60 * 60);
    expect(Number(d.avg_visit_sec)).toBeCloseTo(20 * 60, 5);
    expect(Number(d.median_visit_sec)).toBeCloseTo(20 * 60, 5);
    expect(Number(d.revenue_robux)).toBe(100);
    expect(d.paying_users).toBe(1);
  });

  it("hourly_stats splits a session's playtime across hours", async () => {
    const key = await makeKey();
    await play(key, 1, "2026-10-20T10:50:00Z", 20);
    await rollupHours(db(), new Date("2026-10-20T10:00:00Z"), new Date("2026-10-20T12:00:00Z"));
    const rows = (await db().query(`SELECT hour, playtime_sec, visits, leaves FROM hourly_stats ORDER BY hour`)).rows;
    expect(rows.map((r) => Number(r.playtime_sec))).toEqual([600, 600]);
    expect(rows.map((r) => r.visits)).toEqual([1, 0]);
    expect(rows.map((r) => r.leaves)).toEqual([0, 1]);
  });

  it("the reporting time zone decides which day activity belongs to", async () => {
    const key = await makeKey();
    await play(key, 1, "2026-10-20T23:30:00Z", 10);
    await rebuildPlayerDays(db(), "Asia/Tokyo");
    await rollupDays(db(), "Asia/Tokyo", "2026-10-20", "2026-10-21");
    expect((await db().query(`SELECT day::text FROM daily_stats`)).rows.map((r) => r.day)).toEqual(["2026-10-21"]);
    await db().query(`DELETE FROM daily_stats`);
    await rebuildPlayerDays(db(), "America/New_York");
    await rollupDays(db(), "America/New_York", "2026-10-20", "2026-10-21");
    expect((await db().query(`SELECT day::text FROM daily_stats`)).rows.map((r) => r.day)).toEqual(["2026-10-20"]);
  });
});

describe("retention", () => {
  beforeEach(resetDb);

  it("computes calendar-day retention and never writes unfinished days", async () => {
    const key = await makeKey();
    for (const uid of [1, 2, 3, 4]) await play(key, uid, "2026-10-20T12:00:00Z", 5);
    await play(key, 1, "2026-10-21T09:00:00Z", 5);
    await play(key, 2, "2026-10-21T20:00:00Z", 5);
    await play(key, 5, "2026-10-21T20:00:00Z", 5); // new cohort
    await play(key, 1, "2026-10-27T08:00:00Z", 5);
    await rollupPlayerDays(db(), "UTC", new Date(0));
    await rollupRetention(db(), "UTC", "2026-10-28");

    const cells = (await db().query(`SELECT cohort_day::text AS c, day_offset AS n, cohort_size AS s, retained AS r FROM retention_cohorts WHERE env='production' ORDER BY 1,2`)).rows;
    const get = (c: string, n: number) => cells.find((x) => x.c === c && x.n === n);
    expect(get("2026-10-20", 0)).toMatchObject({ s: 4, r: 4 });
    expect(get("2026-10-20", 1)).toMatchObject({ s: 4, r: 2 });
    expect(get("2026-10-20", 2)).toMatchObject({ r: 0 }); // day over, nobody came back: a real zero
    expect(get("2026-10-20", 7)).toMatchObject({ r: 1 });
    expect(get("2026-10-20", 8)).toBeUndefined(); // 2026-10-28 is today: not over, no cell
    expect(get("2026-10-21", 0)).toMatchObject({ s: 1, r: 1 });
    expect(get("2026-10-21", 6)).toMatchObject({ r: 0 });
    expect(get("2026-10-21", 7)).toBeUndefined();
  });
});

describe("date ranges", () => {
  it("resolves presets in the reporting time zone with a same-length comparison period", async () => {
    const now = new Date("2026-10-20T15:00:00Z");
    const today = await resolveRange(db(), { range: "today", env: "production" }, "America/New_York", now);
    expect(today.from.toISOString()).toBe("2026-10-20T04:00:00.000Z"); // EDT midnight
    expect(today.to.toISOString()).toBe(now.toISOString());
    expect(today.previous!.from.toISOString()).toBe("2026-10-19T04:00:00.000Z");
    expect(today.previous!.to.toISOString()).toBe("2026-10-19T15:00:00.000Z"); // yesterday up to the same time
    const y = await resolveRange(db(), { range: "yesterday", env: "production" }, "UTC", now);
    expect([y.from.toISOString(), y.to.toISOString(), y.complete]).toEqual(["2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z", true]);
    const w = await resolveRange(db(), { range: "7d", env: "production" }, "UTC", now);
    expect([w.fromDay, w.toDay, w.previous!.fromDay, w.previous!.toDay]).toEqual(["2026-10-14", "2026-10-20", "2026-10-07", "2026-10-13"]);
    const c = await resolveRange(db(), { range: "custom", from: "2026-10-01", to: "2026-10-03", env: "production" }, "UTC", now);
    expect([c.from.toISOString(), c.to.toISOString(), c.granularity]).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-04T00:00:00.000Z", "day"]);
  });

  it("handles a day that is 25 hours long (DST end)", async () => {
    const r = await resolveRange(db(), { range: "custom", from: "2026-11-01", to: "2026-11-01", env: "production" }, "America/New_York", new Date("2026-12-01T00:00:00Z"));
    expect((r.to.getTime() - r.from.getTime()) / 3600_000).toBe(25);
  });
});
