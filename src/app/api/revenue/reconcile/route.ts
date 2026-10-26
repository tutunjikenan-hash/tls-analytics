import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/auth/auth";
import { tx } from "@/server/db";
import { clientIp, handler, json, requireUser } from "@/server/http";

export const runtime = "nodejs";

/**
 * Reconciliation with official Roblox records. Accepts rows the owner prepared from an official
 * report (Creator Hub sales export, transaction history): purchase id + the verified creator amount,
 * and/or a refund flag. Only rows matching a purchase we recorded are applied; the rest are listed back
 * so nothing is silently dropped. Verified amounts are shown separately from estimates.
 */
const row = z.object({
  purchaseId: z.string().trim().min(1).max(100),
  verifiedCreatorRobux: z.number().int().min(0).max(10_000_000).optional(),
  refunded: z.boolean().optional(),
});
const body = z.object({ env: z.enum(["production", "studio", "simulation"]).default("production"), rows: z.array(row).min(1).max(5000), dryRun: z.boolean().default(false) });

export const POST = handler(async (req: NextRequest) => {
  const u = await requireUser(req, "reconcile");
  const b = body.parse(await req.json());
  const result = await tx(async (c) => {
    let matched = 0;
    const unmatched: string[] = [];
    for (const r of b.rows) {
      const { rowCount } = await c.query(
        `UPDATE purchases SET
           verified_creator_robux = COALESCE($3, verified_creator_robux),
           refunded_at = CASE WHEN $4::boolean IS TRUE THEN COALESCE(refunded_at, now()) WHEN $4::boolean IS FALSE THEN NULL ELSE refunded_at END,
           reconciled_at = now()
         WHERE env = $1 AND purchase_id = $2`,
        [b.env, r.purchaseId, r.verifiedCreatorRobux ?? null, r.refunded ?? null],
      );
      if (rowCount) matched++;
      else if (unmatched.length < 200) unmatched.push(r.purchaseId);
    }
    if (b.dryRun) throw Object.assign(new Error("dry run"), { dry: { matched, unmatched } });
    // refunds change past days: the job runner recomputes the aggregates (within a minute)
    if (matched > 0) await c.query(`INSERT INTO job_state (name, info) VALUES ('rebuild_requested', '{}') ON CONFLICT (name) DO NOTHING`);
    return { matched, unmatched };
  }).catch((err) => {
    if (err.dry) return { ...err.dry, dryRun: true };
    throw err;
  });
  if (!("dryRun" in result)) await audit(u.id, "revenue_reconciled", b.env, { rows: b.rows.length, matched: result.matched }, clientIp(req));
  return json(result);
});
