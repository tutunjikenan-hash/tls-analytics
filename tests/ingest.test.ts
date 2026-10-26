import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db";
import { handleIngest } from "@/server/ingest/handler";
import { ev, makeKey, min, resetDb, send, T0 } from "./helpers";

const count = async (table: string) => Number((await pool().query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

describe("ingest: authentication and validation", () => {
  beforeEach(resetDb);

  it("rejects missing and wrong keys", async () => {
    const body = JSON.stringify({ v: 1, env: "production", serverId: "s", placeId: 1, sentAt: T0, events: [ev.stop(T0)] });
    expect((await handleIngest({ authorization: null, requestId: randomUUID(), bodyText: body, now: T0 })).status).toBe(401);
    expect((await handleIngest({ authorization: "Bearer tls_nope", requestId: randomUUID(), bodyText: body, now: T0 })).status).toBe(401);
    const key = await makeKey();
    expect((await handleIngest({ authorization: `Bearer ${key}x`, requestId: randomUUID(), bodyText: body, now: T0 })).status).toBe(401);
    expect((await handleIngest({ authorization: `Bearer ${key}`, requestId: randomUUID(), bodyText: body, now: T0 })).status).toBe(200);
  });

  it("rejects a key used for an environment it is not allowed to write", async () => {
    const key = await makeKey(["simulation"]);
    const r = await send([ev.start(randomUUID(), 1, T0)], { key, env: "production" });
    expect(r.status).toBe(403);
    expect(await count("sessions")).toBe(0);
  });

  it("requires a request id and rejects stale or replayed-late requests", async () => {
    const key = await makeKey();
    const body = JSON.stringify({ v: 1, env: "production", serverId: "s", placeId: 1, sentAt: T0, events: [ev.stop(T0)] });
    expect((await handleIngest({ authorization: `Bearer ${key}`, requestId: null, bodyText: body, now: T0 })).status).toBe(400);
    const late = await send([ev.stop(T0)], { key, sentAt: T0 - min(16) });
    expect(late.status).toBe(400);
  });

  it("rejects one malformed event without dropping the rest of the batch", async () => {
    const key = await makeKey();
    const good = ev.start(randomUUID(), 10, T0);
    const bad = { id: randomUUID(), type: "session_start", ts: T0, sid: "not-a-uuid", uid: 10 };
    const tooOld = ev.start(randomUUID(), 11, T0 - 8 * 86400_000);
    const r = await send([good, bad, tooOld], { key });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(1);
    expect(r.body.rejected).toBe(2);
    expect(await count("sessions")).toBe(1);
  });

  it("accepts Roblox's JSONEncode of an empty table ([]) as an empty object", async () => {
    const key = await makeKey();
    const sid = randomUUID();
    const r = await send([
      { id: randomUUID(), type: "server_start", ts: T0, d: [] },
      { id: randomUUID(), type: "session_start", ts: T0, sid, uid: 5, d: [] },
      { id: randomUUID(), type: "game", ts: T0, sid, uid: 5, d: { name: "lobby_joined", props: [] } },
    ], { key });
    expect(r.body.rejected).toBe(0);
    expect(r.body.accepted).toBe(3);
  });

  it("never stores Roblox UserIds", async () => {
    const key = await makeKey();
    const sid = randomUUID();
    await send([ev.start(sid, 987654321, T0), ev.hb(T0 + 10_000, [{ sid, uid: 987654321 }])], { key });
    const dump = JSON.stringify((await pool().query(`SELECT payload FROM raw_events`)).rows);
    expect(dump).not.toContain("987654321");
    const pk = (await pool().query(`SELECT player_key FROM players`)).rows[0].player_key as string;
    expect(pk).toMatch(/^[0-9a-f]{24}$/);
  });

  it("rate limits per server", async () => {
    const key = await makeKey();
    let limited = 0;
    for (let i = 0; i < 125; i++) {
      const r = await send([ev.hb(T0, [])], { key, serverId: "flood" });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    // another server is unaffected
    expect((await send([ev.hb(T0, [])], { key, serverId: "other" })).status).toBe(200);
  });
});

describe("ingest: deduplication and replay protection", () => {
  beforeEach(resetDb);

  it("a retried request (same request id) is processed once", async () => {
    const key = await makeKey();
    const requestId = randomUUID();
    const events = [ev.start(randomUUID(), 1, T0), ev.purchase(1, T0 + 1000, { purchaseId: "r-1", kind: "developer_product", productId: 5, robux: 100, priceSource: "receipt_currency_spent", status: "confirmed" })];
    const a = await send(events, { key, requestId });
    const b = await send(events, { key, requestId });
    expect(a.body.accepted).toBe(2);
    expect(b.body.duplicate).toBe(true);
    expect(await count("sessions")).toBe(1);
    expect(await count("purchases")).toBe(1);
  });

  it("the same events in a new request (client re-batched after a timeout) are not double counted", async () => {
    const key = await makeKey();
    const events = [ev.start(randomUUID(), 1, T0), ev.purchase(1, T0 + 1000, { purchaseId: "r-2", kind: "developer_product", productId: 5, robux: 100, priceSource: "receipt_currency_spent", status: "confirmed" })];
    await send(events, { key });
    const again = await send(events, { key });
    expect(again.body.accepted).toBe(0);
    expect(again.body.duplicates).toBe(2);
    const { rows } = await pool().query(`SELECT sum(robux_gross) AS r FROM purchases`);
    expect(Number(rows[0].r)).toBe(100);
  });

  it("the same purchase id sent with a different event id is still one purchase", async () => {
    const key = await makeKey();
    const d = { purchaseId: "r-3", kind: "developer_product", productId: 5, robux: 100, priceSource: "receipt_currency_spent", status: "confirmed" };
    await send([ev.purchase(1, T0, d)], { key });
    await send([ev.purchase(1, T0 + 5000, d)], { key });
    expect(await count("purchases")).toBe(1);
  });

  it("repeated event ids inside one batch count once", async () => {
    const key = await makeKey();
    const e = ev.start(randomUUID(), 1, T0);
    const r = await send([e, e, e], { key });
    expect(r.body.accepted).toBe(1);
    expect(await count("raw_events")).toBe(1);
  });

  it("records tracking start from the first production event time", async () => {
    const key = await makeKey(["production", "simulation"]);
    await send([ev.start(randomUUID(), 1, T0)], { key, env: "simulation" });
    let v = (await pool().query(`SELECT value FROM settings WHERE key='tracking_started_at'`)).rows[0].value;
    expect(v).toBeNull();
    await send([ev.start(randomUUID(), 1, T0 + 5000)], { key, env: "production" });
    v = (await pool().query(`SELECT value FROM settings WHERE key='tracking_started_at'`)).rows[0].value;
    expect(new Date(v).getTime()).toBe(T0 + 5000);
  });
});
