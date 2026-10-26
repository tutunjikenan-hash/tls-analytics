import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db";
import { reap, sampleCcu } from "@/server/jobs/live";
import { ccuNow, lifetimeVisits, playtimeSeconds, uniquePlayers, visitLengths, visits } from "@/server/metrics/core";
import { ev, makeKey, min, resetDb, sec, send, T0 } from "./helpers";

const P = "production";
const win = (a: number, b: number) => ({ from: new Date(a), to: new Date(b), fromDay: "", toDay: "" });
const db = () => pool();

describe("sessions, visits and CCU", () => {
  beforeEach(resetDb);

  it("counts joins, leaves, playtime and CCU for a simple session", async () => {
    const key = await makeKey();
    const s1 = randomUUID(), s2 = randomUUID();
    await send([ev.start(s1, 1, T0), ev.start(s2, 2, T0 + sec(30))], { key, now: T0 + sec(30) });
    await send([ev.hb(T0 + sec(40), [{ sid: s1, uid: 1 }, { sid: s2, uid: 2 }])], { key, now: T0 + sec(40) });
    expect((await ccuNow(db(), P, 45, new Date(T0 + sec(50)))).ccu).toBe(2);
    await send([ev.hb(T0 + min(10) - sec(5), [{ sid: s1, uid: 1 }, { sid: s2, uid: 2 }])], { key, now: T0 + min(10) - sec(5) });
    await send([ev.end(s1, 1, T0 + min(10), { reason: "left", durationSec: 600 })], { key, now: T0 + min(10) });
    expect((await ccuNow(db(), P, 45, new Date(T0 + min(10)))).ccu).toBe(1);
    await send([ev.end(s2, 2, T0 + min(20), { reason: "left" })], { key, now: T0 + min(20) });

    const w = win(T0 - min(60), T0 + min(60));
    expect(await visits(db(), P, w)).toBe(2);
    expect(await uniquePlayers(db(), P, w)).toBe(2);
    expect(await playtimeSeconds(db(), P, w)).toBe(600 + (1200 - 30));
    const vl = await visitLengths(db(), P, w);
    expect(vl.closedVisits).toBe(2);
    expect(vl.avgSec).toBeCloseTo((600 + 1170) / 2, 5);
  });

  it("clips playtime to the window", async () => {
    const key = await makeKey();
    const s = randomUUID();
    await send([ev.start(s, 1, T0)], { key });
    await send([ev.end(s, 1, T0 + min(30))], { key, now: T0 + min(30) });
    expect(await playtimeSeconds(db(), P, win(T0 + min(10), T0 + min(20)))).toBe(600);
  });

  it("a teleport between our own servers continues the same visit", async () => {
    const key = await makeKey();
    const lobby = randomUUID(), match = randomUUID();
    await send([ev.start(lobby, 7, T0)], { key, serverId: "lobby" });
    await send([ev.end(lobby, 7, T0 + min(2))], { key, serverId: "lobby", now: T0 + min(2) });
    await send([ev.start(match, 7, T0 + min(2) + sec(20), { teleportIn: true })], { key, serverId: "match", now: T0 + min(3) });
    await send([ev.end(match, 7, T0 + min(12))], { key, serverId: "match", now: T0 + min(12) });

    const w = win(T0 - min(1), T0 + min(60));
    expect(await visits(db(), P, w)).toBe(1); // one visit
    const { rows } = await db().query(`SELECT count(*) AS n FROM sessions`);
    expect(Number(rows[0].n)).toBe(2); // two server sessions
    const vl = await visitLengths(db(), P, w);
    expect(vl.avgSec).toBe(12 * 60); // first join .. last leave
    expect((await lifetimeVisits(db(), P)).visits).toBe(1);
  });

  it("a teleportIn flag with no recent session starts a new visit", async () => {
    const key = await makeKey();
    const a = randomUUID(), b = randomUUID();
    await send([ev.start(a, 7, T0), ev.end(a, 7, T0 + min(1))], { key });
    await send([ev.start(b, 7, T0 + min(30), { teleportIn: true })], { key, now: T0 + min(30) });
    expect(await visits(db(), P, win(T0 - 1, T0 + min(60)))).toBe(2);
  });

  it("the same player in two servers at once counts once in CCU", async () => {
    const key = await makeKey();
    const a = randomUUID(), b = randomUUID();
    await send([ev.start(a, 1, T0), ev.hb(T0 + sec(5), [{ sid: a, uid: 1 }])], { key, serverId: "x", now: T0 + sec(5) });
    await send([ev.start(b, 1, T0 + sec(2)), ev.hb(T0 + sec(5), [{ sid: b, uid: 1 }])], { key, serverId: "y", now: T0 + sec(5) });
    const c = await ccuNow(db(), P, 45, new Date(T0 + sec(10)));
    expect(c.ccu).toBe(1);
    expect(c.sessions).toBe(2);
    expect(c.servers).toBe(2);
  });

  it("environments are kept apart", async () => {
    const key = await makeKey(["production", "studio", "simulation"]);
    await send([ev.start(randomUUID(), 1, T0)], { key, env: "simulation" });
    await send([ev.start(randomUUID(), 2, T0)], { key, env: "studio" });
    expect(await visits(db(), P, win(T0 - 1, T0 + 1000))).toBe(0);
    expect(await visits(db(), "simulation", win(T0 - 1, T0 + 1000))).toBe(1);
  });
});

describe("disconnected servers and reconciliation", () => {
  beforeEach(resetDb);

  it("a server that stops heartbeating is closed, with its sessions, at the last heartbeat", async () => {
    const key = await makeKey();
    const s = randomUUID();
    await send([ev.start(s, 1, T0), ev.hb(T0 + sec(10), [{ sid: s, uid: 1 }])], { key, serverId: "crashy", now: T0 + sec(10) });
    await send([ev.hb(T0 + sec(20), [{ sid: s, uid: 1 }])], { key, serverId: "crashy", now: T0 + sec(20) });
    // server vanishes; nothing more arrives
    expect((await ccuNow(db(), P, 45, new Date(T0 + sec(60)))).ccu).toBe(1);
    expect((await ccuNow(db(), P, 45, new Date(T0 + sec(70)))).ccu).toBe(0); // heartbeat expired

    const r = await reap(db(), 45, new Date(T0 + sec(70)));
    expect(r.servers).toBe(1);
    expect(r.sessions).toBe(1);
    const srv = (await db().query(`SELECT ended_at, end_reason FROM servers`)).rows[0];
    expect(srv.end_reason).toBe("lost");
    expect(new Date(srv.ended_at).getTime()).toBe(T0 + sec(20));
    const ses = (await db().query(`SELECT ended_at, end_reason FROM sessions`)).rows[0];
    expect(ses.end_reason).toBe("timeout");
    expect(new Date(ses.ended_at).getTime()).toBe(T0 + sec(20));
    expect(await playtimeSeconds(db(), P, win(T0 - 1, T0 + min(60)))).toBe(20);
  });

  it("a server that comes back after a network hiccup reopens its sessions", async () => {
    const key = await makeKey();
    const s = randomUUID();
    await send([ev.start(s, 1, T0), ev.hb(T0 + sec(10), [{ sid: s, uid: 1 }])], { key, now: T0 + sec(10) });
    await reap(db(), 45, new Date(T0 + sec(60)));
    expect((await db().query(`SELECT ended_at FROM sessions`)).rows[0].ended_at).not.toBeNull();
    // delayed batch arrives
    await send([ev.hb(T0 + sec(70), [{ sid: s, uid: 1 }])], { key, now: T0 + sec(75) });
    const ses = (await db().query(`SELECT ended_at, last_seen_at FROM sessions`)).rows[0];
    expect(ses.ended_at).toBeNull();
    expect(new Date(ses.last_seen_at).getTime()).toBe(T0 + sec(70));
    const srv = (await db().query(`SELECT ended_at FROM servers`)).rows[0];
    expect(srv.ended_at).toBeNull();
    expect((await ccuNow(db(), P, 45, new Date(T0 + sec(80)))).ccu).toBe(1);
  });

  it("a session whose start event was lost is inferred from heartbeats", async () => {
    const key = await makeKey();
    const s = randomUUID();
    await send([ev.hb(T0 + sec(10), [{ sid: s, uid: 3, stage: "lobby" }]), ev.hb(T0 + sec(20), [{ sid: s, uid: 3, stage: "night_1" }])], { key, now: T0 + sec(20) });
    const row = (await db().query(`SELECT inferred_start, started_at, stage FROM sessions`)).rows[0];
    expect(row.inferred_start).toBe(true);
    expect(new Date(row.started_at).getTime()).toBe(T0 + sec(10));
    expect(row.stage).toBe("night_1");
    // the late start event fixes the start time
    await send([ev.start(s, 3, T0 + sec(2))], { key, now: T0 + sec(25) });
    const fixed = (await db().query(`SELECT inferred_start, started_at FROM sessions`)).rows[0];
    expect(fixed.inferred_start).toBe(false);
    expect(new Date(fixed.started_at).getTime()).toBe(T0 + sec(2));
  });

  it("events arriving out of order give the same result", async () => {
    const key = await makeKey();
    const s = randomUUID();
    await send([ev.end(s, 4, T0 + min(5), { durationSec: 300 })], { key, now: T0 + min(5) });
    await send([ev.start(s, 4, T0)], { key, now: T0 + min(5) });
    const row = (await db().query(`SELECT started_at, ended_at FROM sessions`)).rows[0];
    expect(new Date(row.started_at).getTime()).toBe(T0);
    expect(new Date(row.ended_at).getTime()).toBe(T0 + min(5));
    expect(await visits(db(), P, win(T0 - 1, T0 + min(10)))).toBe(1);
  });

  it("a late heartbeat from before a shutdown does not reopen the server, a later one does", async () => {
    const key = await makeKey();
    await send([ev.hb(T0, []), ev.stop(T0 + min(1))], { key, serverId: "re", now: T0 + min(1) });
    await send([ev.hb(T0 + sec(30), [])], { key, serverId: "re", now: T0 + min(2) });
    expect((await db().query(`SELECT end_reason FROM servers`)).rows[0].end_reason).toBe("shutdown");
    await send([ev.hb(T0 + min(3), [])], { key, serverId: "re", now: T0 + min(3) });
    expect((await db().query(`SELECT ended_at FROM servers`)).rows[0].ended_at).toBeNull();
  });

  it("server_stop closes everyone still on that server", async () => {
    const key = await makeKey();
    const a = randomUUID(), b = randomUUID();
    await send([ev.start(a, 1, T0), ev.start(b, 2, T0)], { key, serverId: "z" });
    await send([ev.stop(T0 + min(3))], { key, serverId: "z", now: T0 + min(3) });
    const { rows } = await db().query(`SELECT end_reason, ended_at FROM sessions`);
    expect(rows.every((r) => r.end_reason === "server_shutdown" && new Date(r.ended_at).getTime() === T0 + min(3))).toBe(true);
    expect((await db().query(`SELECT end_reason FROM servers`)).rows[0].end_reason).toBe("shutdown");
  });

  it("CCU samples are stored per minute with the peak", async () => {
    const key = await makeKey();
    const a = randomUUID(), b = randomUUID();
    await send([ev.start(a, 1, T0), ev.start(b, 2, T0)], { key });
    await sampleCcu(db(), 45, new Date(T0 + sec(5)));
    await send([ev.end(b, 2, T0 + sec(20))], { key, now: T0 + sec(20) });
    await sampleCcu(db(), 45, new Date(T0 + sec(25)));
    const r = (await db().query(`SELECT peak_ccu, last_ccu, samples FROM ccu_minutes WHERE env='production'`)).rows;
    expect(r).toHaveLength(1);
    expect(r[0].peak_ccu).toBe(2);
    expect(r[0].last_ccu).toBe(1);
    // empty environments get no rows
    expect(Number((await db().query(`SELECT count(*) AS n FROM ccu_minutes WHERE env <> 'production'`)).rows[0].n)).toBe(0);
  });
});
