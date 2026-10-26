import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db";
import { sampleCcu } from "@/server/jobs/live";
import { rollupDays, rollupHours, rollupPlayerDays, rollupRetention } from "@/server/jobs/rollups";
import { engagementPage, retentionPage } from "@/server/metrics/engagement";
import { gameplayPage } from "@/server/metrics/gameplay";
import { growthPage } from "@/server/metrics/growth";
import { livePage } from "@/server/metrics/live";
import { overview } from "@/server/metrics/overview";
import { revenuePage } from "@/server/metrics/revenue";
import { serversPage } from "@/server/metrics/servers";
import { ev, makeKey, min, resetDb, sec, send } from "./helpers";

const NOW = new Date("2026-10-20T18:00:00Z");
const db = () => pool();

describe("dashboard pages on an empty database", () => {
  beforeAll(resetDb);
  it("return empty states, not zeros pretending to be data", async () => {
    const o = await overview(db(), { range: "7d", env: "production" }, NOW);
    expect(o.hasData).toBe(false);
    expect(o.series).toEqual([]);
    expect(o.kpis.visits.previous).toBeNull();
    expect(o.kpis.avgPlaytime.value).toBeNull();
    const rev = await revenuePage(db(), { range: "30d", env: "production" }, NOW);
    expect(rev.ratios.arppu).toBeNull();
    expect(rev.ratios.conversionPct).toBeNull();
    const ret = await retentionPage(db(), { range: "30d", env: "production" }, NOW);
    expect(ret.summary.d1.pct).toBeNull();
    const g = await gameplayPage(db(), { range: "7d", env: "production" }, NOW);
    expect(g.instrumented).toBe(false);
    expect(g.runs.completionPct).toBeNull();
    const live = await livePage(db(), "production", NOW);
    expect(live.ccu).toBe(0);
    expect(live.ccuLastHour.every((p) => p.ccu === null)).toBe(true);
  });
});

describe("dashboard pages with data", () => {
  beforeAll(async () => {
    await resetDb();
    const key = await makeKey();
    const t = NOW.getTime() - min(60);
    const s = [randomUUID(), randomUUID(), randomUUID()];
    await send([
      { id: randomUUID(), type: "server_start", ts: t },
      ev.start(s[0], 1, t, { country: "US" }), ev.start(s[1], 2, t + sec(5), { country: "DE", referred: true }), ev.start(s[2], 3, t + sec(9)),
      ev.game(1, t + sec(20), { name: "lobby_joined" }, s[0]), ev.game(2, t + sec(20), { name: "lobby_joined" }, s[1]),
      ev.game(1, t + sec(40), { name: "gate_entered" }, s[0]),
      ev.game(1, t + min(1), { name: "run_start", runId: "r1", chapter: "ch1", stage: "night_1" }, s[0]),
      ev.game(2, t + min(1), { name: "run_start", runId: "r2", chapter: "ch1", stage: "night_1" }, s[1]),
      ev.game(1, t + min(5), { name: "death", chapter: "ch1", area: "parking_lot", props: { cause: "watcher" } }, s[0]),
      ev.purchase(1, t + min(6), { purchaseId: "rc-1", kind: "developer_product", productId: 42, productName: "Revive", robux: 25, priceSource: "receipt_currency_spent", status: "confirmed" }),
      ev.purchase(2, t + min(7), { purchaseId: "-", kind: "game_pass", productId: 77, productName: "VIP", robux: 199, priceSource: "catalog_list_price", status: "confirmed" }),
      { id: randomUUID(), type: "counter", ts: t + min(6), d: { name: "purchase_prompt", value: 4 } },
    ], { key, serverId: "srv-1", now: t + min(8), sentAt: t + min(8) });
    await send([
      ev.game(1, t + min(20), { name: "run_complete", runId: "r1", chapter: "ch1", stage: "night_1" }, s[0]),
      ev.game(2, t + min(12), { name: "run_fail", runId: "r2", chapter: "ch1", stage: "night_1", props: { reason: "five_mistakes" } }, s[1]),
      ev.end(s[2], 3, t + min(15)),
      ev.hb(NOW.getTime() - sec(10), [{ sid: s[0], uid: 1, stage: "night_1" }, { sid: s[1], uid: 2, stage: "lobby" }]),
    ], { key, serverId: "srv-1", now: NOW.getTime() - sec(5), sentAt: NOW.getTime() - sec(5) });
    await sampleCcu(db(), 45, new Date(NOW.getTime() - sec(5)));
    await rollupPlayerDays(db(), "UTC", new Date(0));
    await rollupHours(db(), new Date("2026-10-20T00:00:00Z"), NOW);
    await rollupDays(db(), "UTC", "2026-10-14", "2026-10-20");
    await rollupRetention(db(), "UTC", "2026-10-20");
  });

  it("overview", async () => {
    const o = await overview(db(), { range: "today", env: "production" }, NOW);
    expect(o.hasData).toBe(true);
    expect(o.live.ccu).toBe(2);
    expect(o.kpis.visits.value).toBe(3);
    expect(o.kpis.activePlayers.value).toBe(3);
    expect(o.kpis.revenue.value).toBe(224);
    expect(o.kpis.revenueLifetime.value).toBe(224);
    expect(o.kpis.peakCcu.value).toBe(2);
    expect(o.kpis.visits.previous).toBeNull(); // previous period is before tracking started
    expect(o.series.length).toBe(18); // hourly buckets 00:00..17:00
    expect(o.series[17].visits).toBe(3);
    expect(o.series[0].visits).toBeNull(); // before tracking
  });

  it("live", async () => {
    const l = await livePage(db(), "production", NOW);
    expect(l.ccu).toBe(2);
    expect(l.servers).toBe(1);
    expect(l.serverList[0].players).toBe(2);
    expect(l.stages).toEqual(expect.arrayContaining([{ stage: "night_1", players: 1 }, { stage: "lobby", players: 1 }]));
    expect(l.regions.find((x) => x.country === "US")?.players).toBe(1);
    expect(l.joinsLeaves.reduce((a, m) => a + m.joins, 0)).toBe(3);
  });

  it("revenue", async () => {
    const r = await revenuePage(db(), { range: "today", env: "production" }, NOW);
    expect(r.windows.selected.grossRobux).toBe(224);
    expect(r.windows.selected.estimatedCreatorRobux).toBe(17 + 139);
    expect(r.windows.selected.verifiedCreatorRobux).toBeNull();
    expect(r.byKind.find((k) => k.kind === "game_pass")?.grossRobux).toBe(199);
    expect(r.topProducts[0].name).toBe("VIP");
    expect(r.ratios.conversionPct).toBeCloseTo((2 / 3) * 100, 5);
    expect(r.ratios.arppu).toBe(112);
    expect(r.ratios.promptConversionPct).toBe(50);
    expect(r.recent).toHaveLength(2);
  });

  it("engagement and retention", async () => {
    const e = await engagementPage(db(), { range: "today", env: "production" }, NOW);
    expect(e.activePlayers).toBe(3);
    expect(e.newPlayers).toBe(3);
    expect(e.visitLength.closedVisits).toBe(1);
    expect(e.lengthDistribution.find((b) => b.bucket === "10-20m")?.visits).toBe(1);
    expect(e.churn).toBeNull(); // previous period had nobody: no invented base
    const r = await retentionPage(db(), { range: "30d", env: "production" }, NOW);
    expect(r.cohorts).toHaveLength(0); // today is not over yet, so no cells
  });

  it("gameplay", async () => {
    const g = await gameplayPage(db(), { range: "today", env: "production" }, NOW);
    expect(g.instrumented).toBe(true);
    expect(g.runs).toMatchObject({ started: 2, completed: 1, failed: 1, abandoned: 0 });
    expect(g.runs.completionPct).toBe(50);
    expect(g.runs.medianCompleteSec).toBe(19 * 60);
    expect(g.deathsByCause[0]).toEqual({ cause: "watcher", deaths: 1 });
    expect(g.funnel.map((f) => f.players)).toEqual([2, 1, 1, 0, 0, 0]);
    expect(g.stages[0]).toMatchObject({ chapter: "ch1", stage: "night_1", completionPct: 50 });
  });

  it("growth and servers", async () => {
    const gr = await growthPage(db(), { range: "today", env: "production" }, NOW);
    expect(gr.newPlayers).toBe(3);
    expect(gr.shareLinkVisits).toEqual({ referred: 1, visits: 3 });
    expect(gr.unavailable.length).toBeGreaterThan(0);
    const sv = await serversPage(db(), { range: "today", env: "production" }, NOW);
    expect(sv.started).toBe(1);
    expect(sv.running).toBe(1);
    expect(sv.liveVersions).toEqual([{ placeVersion: "7", servers: 1 }]);
  });
});
