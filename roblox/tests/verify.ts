/**
 * Checks the requests the real TLSAnalytics Luau module produced (harness output), then replays the
 * successful ones against a running dashboard and checks what was stored.
 *   python3 run.py <luau> > out.txt && npx tsx roblox/tests/verify.ts out.txt
 * Needs DATABASE_URL and the dashboard at TLS_INGEST_URL (default localhost:3000).
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";

const lines = readFileSync(process.argv[2], "utf8").split("\n");
const reqs = lines.filter((l) => l.startsWith("REQ|")).map((l) => {
  const [, status, id, auth, ...rest] = l.split("|");
  return { status: Number(status), id, auth, body: rest.join("|"), json: JSON.parse(rest.join("|")) };
});
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failed++;
};
const ok200 = reqs.filter((r) => r.status === 200);
const events = ok200.flatMap((r) => r.json.events);
const byType = (t: string) => events.filter((e: { type: string }) => e.type === t);

check("503, then a proxy 401 without our error code: retried with the same request id until accepted", reqs[0].status === 503 && reqs[1].status === 401 && reqs[2].status === 200 && reqs[0].id === reqs[1].id && reqs[1].id === reqs[2].id);
check("every successful request has a distinct request id", new Set(ok200.map((r) => r.id)).size === ok200.length);
check("no event id is sent twice", new Set(events.map((e: { id: string }) => e.id)).size === events.length);
check("key sent as Bearer header", reqs.every((r) => r.auth.startsWith("Bearer tls_")));
check("no empty-object [] payloads", !/"d":\[\]/.test(ok200.map((r) => r.body).join("")));
check("server_start sent once", byType("server_start").length === 1);
const starts = byType("session_start");
check("two sessions started", starts.length === 2);
const p2 = starts.find((e: { uid: number }) => e.uid === 1002);
check("teleport and share-link detected from join data", p2?.d?.teleportIn === true && p2?.d?.referred === true, JSON.stringify(p2?.d));
check("country included", starts.every((e: { d?: { country?: string } }) => e.d?.country === "US"));
const purchases = byType("purchase");
const dev = purchases.filter((e: { d: { kind: string } }) => e.d.kind === "developer_product");
check("granted receipt recorded with CurrencySpent", dev.some((e: { d: { purchaseId: string; robux: number; status: string } }) => e.d.purchaseId === "PURCHASE-ABC" && e.d.robux === 25 && e.d.status === "confirmed"));
check("NotProcessedYet and erroring receipts NOT recorded as purchases", !dev.some((e: { d: { purchaseId: string } }) => e.d.purchaseId === "PURCHASE-DEF" || e.d.purchaseId === "PURCHASE-XYZ"));
check("a receipt granted before start() is still recorded", dev.some((e: { d: { purchaseId: string } }) => e.d.purchaseId === "PURCHASE-EARLY"));
const messy = byType("game").find((e: { d: { name: string } }) => e.d.name === "messy_props");
const mp = messy?.d?.props ?? {};
check("non-finite numbers dropped, strings clipped on UTF-8 boundaries, invalid UTF-8 neutralised",
  !!messy && messy.d.value === undefined && !("bad" in mp) && !("inf" in mp) && mp.ok === 3 &&
  Buffer.byteLength(mp.txt) <= 200 && !mp.txt.includes("\uFFFD") && Buffer.byteLength(messy.d.stage) <= 32 && mp.raw === "?abc",
  JSON.stringify({ value: messy?.d?.value, stage: messy?.d?.stage?.length, props: Object.keys(mp), txt: mp.txt?.length, raw: mp.raw }));
const gp = purchases.filter((e: { d: { kind: string } }) => e.d.kind === "game_pass");
check("game pass confirmed only after ownership check", gp.length === 1 && gp[0].d.status === "confirmed" && gp[0].d.robux === 199, JSON.stringify(gp.map((g: { d: unknown }) => g.d)));
const counters = byType("counter").reduce((m: Record<string, number>, e: { d: { name: string; value: number } }) => ({ ...m, [e.d.name]: (m[e.d.name] ?? 0) + e.d.value }), {});
check("receipt_error, receipt_not_processed, prompt counters", counters.receipt_error === 1 && counters.receipt_not_processed === 1 && counters.gamepass_prompt === 1 && counters.purchase_prompt === 1, JSON.stringify(counters));
const game = byType("game");
check("track(): valid events sent, invalid name dropped", game.some((e: { d: { name: string } }) => e.d.name === "run_start") && !game.some((e: { d: { name: string } }) => e.d.name === "Bad Name"));
const hb = byType("server_heartbeat");
check("heartbeats every ~10 s with players and stage", hb.length >= 8 && hb.some((e: { d: { players: Array<{ stage?: string }> } }) => e.d.players.some((p) => p.stage === "night_2")));
const ends = byType("session_end");
check("leave and shutdown sessions closed", ends.some((e: { uid: number; d: { reason: string } }) => e.uid === 1001 && e.d.reason === "left") && ends.some((e: { uid: number; d: { reason: string } }) => e.uid === 1002 && e.d.reason === "server_shutdown"));
const stopTs = byType("server_stop")[0]?.ts ?? 0;
check("server_stop sent, and nothing after it", stopTs > 0 && events.every((e: { ts: number }) => e.ts <= stopTs));

(async () => {
  const url = process.env.TLS_INGEST_URL ?? "http://localhost:3000/api/ingest/v1/events";
  let accepted = 0;
  for (const r of ok200) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: r.auth, "X-TLS-Request-Id": r.id.toLowerCase() }, body: r.body });
    const j = (await res.json()) as { accepted?: number; rejected?: number; errors?: string[] };
    if (res.status !== 200 || j.rejected) console.log("   backend:", res.status, JSON.stringify(j));
    accepted += j.accepted ?? 0;
  }
  check("backend accepted every event the Luau client produced", accepted === events.length, `${accepted}/${events.length}`);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const srv = (await db.query(`SELECT end_reason FROM servers WHERE env='simulation' AND server_id='job-harness-1'`)).rows[0];
  check("server stored as shut down", srv?.end_reason === "shutdown", JSON.stringify(srv));
  const pur = (await db.query(`SELECT kind, robux_gross, status FROM purchases WHERE env='simulation' AND (purchase_id='PURCHASE-ABC' OR kind='game_pass' AND product_id=777) ORDER BY kind`)).rows;
  check("both purchases stored as confirmed", pur.length === 2 && pur.every((p) => p.status === "confirmed"), JSON.stringify(pur));
  const ses = (await db.query(`SELECT count(*)::int n, count(DISTINCT visit_id)::int v FROM sessions s JOIN servers sv ON sv.env=s.env AND sv.server_id=s.server_id WHERE s.env='simulation' AND s.server_id='job-harness-1' AND s.ended_at IS NOT NULL`)).rows[0];
  check("two closed sessions stored", ses.n === 2, JSON.stringify(ses));
  await db.end();
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
})();
