import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/auth/auth";
import { pool } from "@/server/db";
import { clientIp, handler, json, requireUser } from "@/server/http";

export const runtime = "nodejs";

/**
 * Manually record a number Roblox reports (e.g. lifetime visits from the experience page before
 * tracking began). Stored as source "manual" and always labelled as Roblox-reported.
 */
const body = z.object({
  metric: z.enum(["visits", "favorites", "playing", "lifetime_revenue_robux", "premium_payouts_robux"]),
  value: z.number().int().min(0).max(1e13),
  asOf: z.string().datetime(),
  note: z.string().max(200).optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const u = await requireUser(req, "manage_settings");
  const b = body.parse(await req.json());
  await pool().query(`INSERT INTO roblox_reported (metric, value, as_of, source, note, created_by) VALUES ($1,$2,$3,'manual',$4,$5)`, [b.metric, b.value, b.asOf, b.note ?? null, u.id]);
  await audit(u.id, "roblox_reported_added", b.metric, b, clientIp(req));
  return json({ ok: true }, 201);
});
