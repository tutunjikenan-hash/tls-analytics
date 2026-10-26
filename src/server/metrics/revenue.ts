import type { Queryable } from "../db";
import * as core from "./core";
import { context, describeRange, freshness, knownPrevious } from "./overview";
import { resolveRange, type RangeQuery } from "./range";
import { dailySeries, hourOfDay, seriesForRange } from "./series";

const CONFIRMED = `status = 'confirmed' AND refunded_at IS NULL`;

/**
 * Revenue page. Only purchases the game confirmed (ProcessReceipt returned PurchaseGranted, or a game
 * pass whose ownership UserOwnsGamePassAsync verified) count. Three amounts are kept apart:
 *   gross        Robux the buyer spent (developer products: receipt.CurrencySpent; passes: list price)
 *   estimated    gross × creator share setting (default 70%) — an estimate, not a payout
 *   verified     only after reconciliation against official Roblox reports (null until then)
 * Premium Payouts, private-server and other income are not visible to game servers and are not shown
 * as measured.
 */
export async function revenuePage(db: Queryable, q: RangeQuery, now = new Date()) {
  const { settings, trackingStart, range: r } = await context(db, q, now);
  const prevW = knownPrevious(r, trackingStart);
  const env = q.env;
  const tz = settings.reporting_timezone;
  const W = (p: "today" | "yesterday" | "7d" | "30d" | "90d") => resolveRange(db, { range: p, env }, tz, now, trackingStart);
  const [wToday, wYesterday, w7, w30, w90] = await Promise.all([W("today"), W("yesterday"), W("7d"), W("30d"), W("90d")]);

  const [cur, prev, today, yesterday, d7, d30, d90, life, active, activePrev, activeDaySum] = await Promise.all([
    core.revenue(db, env, r), prevW ? core.revenue(db, env, prevW) : null,
    core.revenue(db, env, wToday), core.revenue(db, env, wYesterday), core.revenue(db, env, w7), core.revenue(db, env, w30), core.revenue(db, env, w90),
    core.lifetimeRevenue(db, env),
    core.uniquePlayers(db, env, r), prevW ? core.uniquePlayers(db, env, prevW) : null,
    // sum of daily active players over the range days (ARPDAU denominator)
    db.query<{ n: string | null }>(`SELECT sum(dau) AS n FROM daily_stats WHERE env = $1 AND day BETWEEN $2::date AND $3::date`, [env, r.fromDay, r.toDay]),
  ]);

  const [byProduct, byKind, recent, attempts, reconciliation] = await Promise.all([
    db.query(
      `SELECT product_id, kind, max(product_name) AS name, count(*) AS n, sum(robux_gross) AS gross, sum(estimated_creator_robux) AS est,
              count(DISTINCT player_key) AS payers, min(price_source) AS price_source
       FROM purchases WHERE env = $1 AND purchased_at >= $2 AND purchased_at < $3 AND ${CONFIRMED}
       GROUP BY product_id, kind ORDER BY gross DESC, n DESC LIMIT 50`,
      [env, r.from, r.to],
    ),
    db.query(
      `SELECT kind, count(*) AS n, sum(robux_gross) AS gross, count(DISTINCT player_key) AS payers
       FROM purchases WHERE env = $1 AND purchased_at >= $2 AND purchased_at < $3 AND ${CONFIRMED} GROUP BY kind`,
      [env, r.from, r.to],
    ),
    db.query(
      `SELECT purchase_id, kind, product_id, product_name, left(player_key, 8) AS player, robux_gross, status, price_source, purchased_at, refunded_at
       FROM purchases WHERE env = $1 ORDER BY purchased_at DESC LIMIT 30`,
      [env],
    ),
    // prompts and errors reported by the game (counters), to compute prompt → purchase conversion
    db.query(
      `SELECT name, sum(value) AS n FROM server_counters WHERE env = $1 AND minute >= date_trunc('minute', $2::timestamptz) AND minute < $3
         AND name IN ('purchase_prompt', 'gamepass_prompt', 'receipt_error', 'receipt_not_processed') GROUP BY name`,
      [env, r.from, r.to],
    ),
    db.query(
      `SELECT count(*) FILTER (WHERE reconciled_at IS NOT NULL) AS reconciled, count(*) AS total, sum(verified_creator_robux) AS verified
       FROM purchases WHERE env = $1 AND ${CONFIRMED}`,
      [env],
    ),
  ]);

  const counters = Object.fromEntries(attempts.rows.map((x) => [x.name as string, Number(x.n)]));
  const prompts = (counters.purchase_prompt ?? 0) + (counters.gamepass_prompt ?? 0);
  const daySum = Number(activeDaySum.rows[0].n ?? 0);
  const div = (a: number, b: number) => (b > 0 ? a / b : null);
  const series = trackingStart ? await seriesForRange(db, env, r, trackingStart) : [];
  const last30 = trackingStart ? await dailySeries(db, env, w30.fromDay, w30.toDay, tz, trackingStart) : [];

  return {
    range: describeRange(r),
    env,
    generatedAt: now.toISOString(),
    hasData: trackingStart !== null,
    freshness: await freshness(db, env),
    creatorShare: settings.creator_share,
    windows: {
      selected: { ...cur, changePct: prev ? core.pctChange(cur.grossRobux, prev.grossRobux) : null, previousGross: prev?.grossRobux ?? null },
      today, yesterday, d7, d30, d90,
      lifetime: { ...life, since: life.since?.toISOString() ?? null },
    },
    ratios: {
      activePlayers: active,
      conversionPct: div(cur.payingUsers * 100, active),
      conversionPctPrev: prev && activePrev ? div(prev.payingUsers * 100, activePrev) : null,
      arpdau: div(cur.grossRobux, daySum),
      arppu: div(cur.grossRobux, cur.payingUsers),
      purchasesPerPayer: div(cur.purchases, cur.payingUsers),
      promptConversionPct: prompts > 0 ? (cur.purchases * 100) / prompts : null,
      prompts: prompts || null,
    },
    errors: { receiptErrors: counters.receipt_error ?? 0, notProcessedYet: counters.receipt_not_processed ?? 0 },
    byKind: ["developer_product", "game_pass"].map((k) => {
      const x = byKind.rows.find((y) => y.kind === k);
      return { kind: k, purchases: Number(x?.n ?? 0), grossRobux: Number(x?.gross ?? 0), payers: Number(x?.payers ?? 0) };
    }),
    topProducts: byProduct.rows.map((x) => ({
      productId: String(x.product_id), kind: x.kind as string, name: (x.name as string | null) ?? `#${x.product_id}`,
      purchases: Number(x.n), grossRobux: Number(x.gross), estimatedCreatorRobux: Number(x.est), payers: Number(x.payers), priceSource: x.price_source as string,
    })),
    recent: recent.rows.map((x) => ({
      purchaseId: x.purchase_id as string, kind: x.kind as string, productId: String(x.product_id), productName: x.product_name as string | null,
      player: x.player as string, robux: Number(x.robux_gross), status: x.refunded_at ? "refunded" : (x.status as string), priceSource: x.price_source as string,
      at: (x.purchased_at as Date).toISOString(),
    })),
    reconciliation: {
      reconciledPurchases: Number(reconciliation.rows[0].reconciled), totalPurchases: Number(reconciliation.rows[0].total),
      verifiedCreatorRobux: reconciliation.rows[0].verified === null ? null : Number(reconciliation.rows[0].verified),
    },
    notTracked: [
      "Premium Payouts (paid by Roblox for Premium members' engagement time) — see the Creator Dashboard",
      "Private server subscriptions, avatar item and UGC sales, commissions",
      "Roblox's final settlement: pending periods, refunds and chargebacks are only known after reconciliation",
    ],
    series,
    last30Days: last30,
    byHourOfDay: await hourOfDay(db, env, r.from, r.to, tz),
  };
}
