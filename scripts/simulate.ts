/**
 * Local simulator: sends realistic game traffic to the ingest endpoint over HTTP, exactly like the
 * Roblox servers do (same wire format, auth, request ids, retries). It writes ONLY to the
 * "simulation" (or "studio") environment and refuses "production", so simulated data never mixes
 * with real players.
 *
 *   TLS_INGEST_URL=http://localhost:3000/api/ingest/v1/events TLS_INGEST_KEY=tls_... \
 *   npm run simulate -- --backfill-days 6 --live-minutes 10 --players 400
 *
 * Product names and ids are fictional ("Sim ..."), not the game's real products.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    env: { type: "string", default: "simulation" },
    "backfill-days": { type: "string", default: "6" },
    "live-minutes": { type: "string", default: "5" },
    players: { type: "string", default: "300" },
    seed: { type: "string", default: "42" },
    "visits-per-day": { type: "string", default: "220" },
  },
});
const ENV = a.env!;
if (ENV === "production") {
  console.error("The simulator never writes to production. Use --env simulation (default) or studio.");
  process.exit(1);
}
const URL_ = process.env.TLS_INGEST_URL ?? "http://localhost:3000/api/ingest/v1/events";
const KEY = process.env.TLS_INGEST_KEY;
if (!KEY) {
  console.error("Set TLS_INGEST_KEY (npm run key:create -- --name Simulator --env simulation)");
  process.exit(1);
}
const BACKFILL = Math.min(6, Math.max(0, Number(a["backfill-days"])));
const LIVE_MIN = Math.max(0, Number(a["live-minutes"]));
const POOL = Math.max(10, Number(a.players));
const VPD = Math.max(10, Number(a["visits-per-day"]));

// deterministic PRNG so runs are reproducible
let seed = Number(a.seed) >>> 0 || 1;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);

const COUNTRIES = ["US", "US", "US", "GB", "CA", "DE", "BR", "PH", "MX", "AU", "FR", "PL", "ID", "TR"];
const PRODUCTS = [
  { id: 900001, name: "Sim Spare Battery", robux: 15, kind: "developer_product" as const },
  { id: 900002, name: "Sim Second Chance", robux: 25, kind: "developer_product" as const },
  { id: 900003, name: "Sim Coffee Pack", robux: 49, kind: "developer_product" as const },
  { id: 900101, name: "Sim Night Pass", robux: 199, kind: "game_pass" as const },
  { id: 900102, name: "Sim Lantern Pass", robux: 99, kind: "game_pass" as const },
];
const AREAS = ["store_front", "parking_lot", "back_room", "restrooms", "pumps", "highway_edge"];
const CAUSES = ["watcher", "night_driver", "power_failure", "wrong_customer", "five_mistakes"];

interface Ev { id: string; type: string; ts: number; sid?: string; uid?: number; d?: Record<string, unknown> }

/* ---------- HTTP client with batching, retries and backoff (mirrors the Luau client) ---------- */
let sent = 0;
let requests = 0;
async function post(serverId: string, kind: string, events: Ev[]) {
  for (let i = 0; i < events.length; i += 400) {
    const batch = events.slice(i, i + 400).map((e) => ({ ...e, ts: Math.round(e.ts) })); // whole milliseconds, like Roblox
    const requestId = randomUUID();
    for (let attempt = 0; attempt < 6; attempt++) {
      const body = JSON.stringify({ v: 1, env: ENV, serverId, placeId: 1, placeVersion: 42, serverKind: kind, sentAt: Date.now(), events: batch });
      let res: Response | null = null;
      try {
        res = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, "X-TLS-Request-Id": requestId }, body });
      } catch (err) {
        console.warn(`  network error (${(err as Error).message}), retrying`);
      }
      if (res?.ok) {
        requests++;
        sent += batch.length;
        const j = (await res.json()) as { rejected?: number; errors?: string[] };
        if (j.rejected) console.warn(`  ${j.rejected} events rejected: ${j.errors?.slice(0, 2).join("; ")}`);
        break;
      }
      if (res && [400, 401, 403, 413].includes(res.status)) throw new Error(`ingest refused the batch: ${res.status} ${await res.text()}`);
      const wait = Number(res?.headers.get("retry-after") ?? 0) * 1000 || Math.min(30_000, 500 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/* ---------- players ---------- */
interface P { uid: number; country: string; skill: number; spender: number; firstDay?: number }
const players: P[] = Array.from({ length: POOL }, (_, i) => ({ uid: 9_000_000_000 + i, country: pick(COUNTRIES), skill: rnd(), spender: rnd() < 0.08 ? rnd() : 0 }));
let nextNew = 0;
const ownedPasses = new Set<string>();

/** One experience visit: lobby session → teleport → shift session with a run. Returns events per server. */
function visit(p: P, t0: number, lobbyId: string, shiftId: string, night: number): { lobby: Ev[]; shift: Ev[]; end: number } {
  const lobby: Ev[] = [];
  const shift: Ev[] = [];
  const ls = randomUUID();
  let t = t0;
  lobby.push({ id: randomUUID(), type: "session_start", ts: t, sid: ls, uid: p.uid, d: { country: p.country, ...(rnd() < 0.06 ? { referred: true } : {}) } });
  lobby.push({ id: randomUUID(), type: "game", ts: t + 2000, sid: ls, uid: p.uid, d: { name: "lobby_joined" } });
  if (rnd() < 0.12) {
    // left from the lobby
    t += between(30, 240) * 1000;
    lobby.push({ id: randomUUID(), type: "session_end", ts: t, sid: ls, uid: p.uid, d: { reason: "left", durationSec: Math.round((t - t0) / 1000) } });
    return { lobby, shift, end: t };
  }
  t += between(15, 90) * 1000;
  lobby.push({ id: randomUUID(), type: "game", ts: t, sid: ls, uid: p.uid, d: { name: "gate_entered" } });
  t += between(10, 40) * 1000;
  lobby.push({ id: randomUUID(), type: "session_end", ts: t, sid: ls, uid: p.uid, d: { reason: "left", durationSec: Math.round((t - t0) / 1000) } });
  // teleport to the shift server
  t += between(5, 20) * 1000;
  const ss = randomUUID();
  const runId = randomUUID().slice(0, 12);
  const chapter = night <= 5 ? "ch1" : "ch2";
  const stage = `night_${night}`;
  shift.push({ id: randomUUID(), type: "session_start", ts: t, sid: ss, uid: p.uid, d: { teleportIn: true, country: p.country } });
  shift.push({ id: randomUUID(), type: "game", ts: t + 1000, sid: ss, uid: p.uid, d: { name: "run_start", runId, chapter, stage } });
  t += between(30, 120) * 1000;
  shift.push({ id: randomUUID(), type: "game", ts: t, sid: ss, uid: p.uid, d: { name: "first_customer", runId, chapter, stage } });
  const difficulty = 0.25 + night * 0.07 - p.skill * 0.3;
  let outcome: "run_complete" | "run_fail" | "run_abandon" = "run_complete";
  const rollEnd = rnd();
  if (rollEnd < 0.13) outcome = "run_abandon";
  else if (rollEnd < 0.13 + Math.max(0.05, difficulty)) outcome = "run_fail";
  // a few horror moments and maybe a death
  for (let i = 0; i < 2 + Math.floor(rnd() * 3); i++) {
    t += between(40, 150) * 1000;
    shift.push({ id: randomUUID(), type: "game", ts: t, sid: ss, uid: p.uid, d: { name: "horror_event", runId, chapter, stage, props: { kind: pick(["knock", "flicker", "figure", "radio"]) } } });
  }
  if (outcome === "run_fail" || rnd() < 0.2) {
    shift.push({ id: randomUUID(), type: "game", ts: t + 5000, sid: ss, uid: p.uid, d: { name: "death", runId, chapter, stage, area: pick(AREAS), props: { cause: pick(CAUSES) } } });
  }
  // purchases
  if (p.spender > 0 && rnd() < 0.35 + p.spender * 0.4) {
    const prod = pick(PRODUCTS);
    shift.push({ id: randomUUID(), type: "counter", ts: t, d: { name: "purchase_prompt", value: 1 } });
    if (prod.kind === "game_pass") {
      const k = `${p.uid}:${prod.id}`;
      if (!ownedPasses.has(k)) {
        ownedPasses.add(k);
        shift.push({ id: randomUUID(), type: "purchase", ts: t + 3000, sid: ss, uid: p.uid, d: { purchaseId: "gp", kind: "game_pass", productId: prod.id, productName: prod.name, robux: prod.robux, priceSource: "catalog_list_price", status: "confirmed" } });
      }
    } else {
      shift.push({ id: randomUUID(), type: "purchase", ts: t + 3000, sid: ss, uid: p.uid, d: { purchaseId: `sim-${randomUUID()}`, kind: "developer_product", productId: prod.id, productName: prod.name, robux: prod.robux, priceSource: "receipt_currency_spent", status: "confirmed" } });
    }
  } else if (rnd() < 0.08) {
    shift.push({ id: randomUUID(), type: "counter", ts: t, d: { name: "purchase_prompt", value: 1 } });
  }
  if (outcome !== "run_abandon") {
    t += between(60, 240) * 1000;
    shift.push({ id: randomUUID(), type: "game", ts: t, sid: ss, uid: p.uid, d: { name: "final_hour", runId, chapter, stage } });
  }
  t += between(20, 120) * 1000;
  if (outcome === "run_abandon") {
    shift.push({ id: randomUUID(), type: "session_end", ts: t, sid: ss, uid: p.uid, d: { reason: "left" } });
  } else {
    shift.push({ id: randomUUID(), type: "game", ts: t, sid: ss, uid: p.uid, d: { name: outcome, runId, chapter, stage, ...(outcome === "run_fail" ? { props: { reason: pick(CAUSES) } } : {}) } });
    t += between(10, 60) * 1000;
    shift.push({ id: randomUUID(), type: "session_end", ts: t, sid: ss, uid: p.uid, d: { reason: "left" } });
  }
  return { lobby, shift, end: t };
}

function choosePlayer(day: number): P {
  // early days: mostly new players; later: returning players with a decaying chance
  const returning = players.filter((p) => p.firstDay !== undefined && day - (p.firstDay as number) >= 1);
  if (nextNew < players.length && (returning.length === 0 || rnd() < 0.45)) {
    const p = players[nextNew++];
    p.firstDay = day;
    return p;
  }
  const weighted = returning.filter((p) => rnd() < 0.35 / (1 + (day - (p.firstDay as number)) * 0.25) + p.skill * 0.2);
  return weighted.length ? pick(weighted) : pick(returning.length ? returning : players.slice(0, Math.max(1, nextNew)));
}

async function backfill() {
  const now = Date.now();
  const startDay = Math.floor((now - BACKFILL * 86400_000) / 86400_000);
  for (let d = 0; d <= BACKFILL; d++) {
    const dayStart = (startDay + d) * 86400_000;
    const dayEnd = Math.min(dayStart + 86400_000, now - 45 * 60_000); // today: visits end before now
    if (dayEnd <= dayStart || dayStart < now - 7 * 86400_000 + 3600_000) continue;
    const weekend = [0, 6].includes(new Date(dayStart).getUTCDay());
    const visits = Math.round(VPD * (weekend ? 1.35 : 1) * (0.85 + d * 0.05) * ((dayEnd - dayStart) / 86400_000));
    const byServer = new Map<string, { kind: string; events: Ev[]; first: number; last: number }>();
    const add = (id: string, kind: string, evs: Ev[]) => {
      const s = byServer.get(id) ?? { kind, events: [], first: Infinity, last: 0 };
      s.events.push(...evs);
      for (const e of evs) {
        s.first = Math.min(s.first, e.ts);
        s.last = Math.max(s.last, e.ts);
      }
      byServer.set(id, s);
    };
    for (let i = 0; i < visits; i++) {
      // evening-heavy distribution
      const hour = (Math.floor(between(0, 24) + (rnd() < 0.5 ? between(0, 8) : 0)) + 10) % 24;
      const t0 = dayStart + hour * 3600_000 + between(0, 3600_000);
      if (t0 > dayEnd - 30 * 60_000) continue;
      const p = choosePlayer(startDay + d);
      const night = Math.min(8, 1 + Math.floor(rnd() * (1 + (startDay + d - (p.firstDay ?? 0)) * 1.5)));
      const slot = Math.floor((t0 - dayStart) / (2 * 3600_000));
      const v = visit(p, t0, `sim-lobby-${d}-${slot}`, `sim-shift-${d}-${slot}-${i % 6}`, night);
      add(`sim-lobby-${d}-${slot}`, "public", v.lobby);
      if (v.shift.length) add(`sim-shift-${d}-${slot}-${i % 6}`, "reserved", v.shift);
    }
    for (const [id, s] of byServer) {
      // a heartbeat at the start keeps server stats realistic; a crash for ~2% of servers
      const crashed = rnd() < 0.02;
      s.events.unshift({ id: randomUUID(), type: "server_start", ts: s.first - 5000 });
      s.events.push({ id: randomUUID(), type: "server_heartbeat", ts: s.first, d: { players: [], fps: between(55, 60), memMb: between(900, 1400), uptimeSec: 5 } });
      if (!crashed) s.events.push({ id: randomUUID(), type: "server_stop", ts: s.last + 5000, d: { reason: "shutdown" } });
      s.events.sort((x, y) => x.ts - y.ts);
      await post(id, s.kind, s.events);
    }
    console.log(`day ${new Date(dayStart).toISOString().slice(0, 10)}: ${visits} visits on ${byServer.size} servers`);
  }
}

/** Real-time mode: servers heartbeat every 10 s with their live players; players join and leave. */
async function live() {
  const end = Date.now() + LIVE_MIN * 60_000;
  interface Live { p: P; sid: string; server: string; leaveAt: number; stage: string }
  const servers = ["sim-live-lobby", "sim-live-shift-a", "sim-live-shift-b", "sim-live-shift-c"];
  for (const s of servers) await post(s, s.includes("lobby") ? "public" : "reserved", [{ id: randomUUID(), type: "server_start", ts: Date.now() }]);
  const online: Live[] = [];
  const today = Math.floor(Date.now() / 86400_000);
  console.log(`live for ${LIVE_MIN} min: heartbeats every 10 s`);
  while (Date.now() < end) {
    const now = Date.now();
    const target = 18 + Math.round(10 * Math.sin(now / 90_000));
    const outbox = new Map<string, Ev[]>(servers.map((s) => [s, []]));
    // leaves
    for (let i = online.length - 1; i >= 0; i--) {
      if (online[i].leaveAt <= now) {
        const o = online[i];
        outbox.get(o.server)!.push({ id: randomUUID(), type: "session_end", ts: now, sid: o.sid, uid: o.p.uid, d: { reason: "left" } });
        online.splice(i, 1);
      }
    }
    // joins toward the target
    const joins = Math.max(0, Math.min(4, target - online.length + (rnd() < 0.5 ? 1 : 0)));
    for (let j = 0; j < joins; j++) {
      const p = choosePlayer(today);
      if (online.some((o) => o.p.uid === p.uid)) continue;
      const server = pick(servers);
      const sid = randomUUID();
      const stage = server.includes("lobby") ? "lobby" : `night_${1 + Math.floor(rnd() * 5)}`;
      online.push({ p, sid, server, leaveAt: now + between(60, 420) * 1000, stage });
      outbox.get(server)!.push({ id: randomUUID(), type: "session_start", ts: now, sid, uid: p.uid, d: { country: p.country } });
      if (rnd() < 0.05 && p.spender > 0) {
        const prod = PRODUCTS[Math.floor(rnd() * 3)];
        outbox.get(server)!.push({ id: randomUUID(), type: "purchase", ts: now + 500, sid, uid: p.uid, d: { purchaseId: `sim-${randomUUID()}`, kind: "developer_product", productId: prod.id, productName: prod.name, robux: prod.robux, priceSource: "receipt_currency_spent", status: "confirmed" } });
      }
    }
    for (const s of servers) {
      const here = online.filter((o) => o.server === s);
      outbox.get(s)!.push({ id: randomUUID(), type: "server_heartbeat", ts: Date.now(), d: { players: here.map((o) => ({ sid: o.sid, uid: o.p.uid, stage: o.stage })), fps: between(52, 60), memMb: between(1000, 1600), uptimeSec: 60 } });
      await post(s, s.includes("lobby") ? "public" : "reserved", outbox.get(s)!);
    }
    process.stdout.write(`\r  ${online.length} players online, ${sent} events sent   `);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  const stops = new Map<string, Ev[]>(servers.map((s) => [s, []]));
  for (const o of online) stops.get(o.server)!.push({ id: randomUUID(), type: "session_end", ts: Date.now(), sid: o.sid, uid: o.p.uid, d: { reason: "server_shutdown" } });
  for (const s of servers) {
    stops.get(s)!.push({ id: randomUUID(), type: "server_stop", ts: Date.now() + 10, d: { reason: "shutdown" } });
    await post(s, "public", stops.get(s)!);
  }
  console.log("");
}

(async () => {
  console.log(`Simulating into "${ENV}" at ${URL_}`);
  if (BACKFILL > 0) await backfill();
  if (LIVE_MIN > 0) await live();
  console.log(`Done: ${sent} events in ${requests} requests.`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
