import type { NextRequest } from "next/server";
import { z } from "zod";
import { can } from "@/server/auth/auth";
import { pool } from "@/server/db";
import { redactRevenue } from "@/server/redact";
import { handler, HttpError, json, requireUser, searchParams } from "@/server/http";
import { engagementPage, retentionPage } from "@/server/metrics/engagement";
import { gameplayPage } from "@/server/metrics/gameplay";
import { growthPage } from "@/server/metrics/growth";
import { livePage } from "@/server/metrics/live";
import { overview } from "@/server/metrics/overview";
import { rangeQuery } from "@/server/metrics/range";
import { revenuePage } from "@/server/metrics/revenue";
import { serversPage } from "@/server/metrics/servers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const gameplayExtra = z.object({
  chapter: z.string().max(32).optional(),
  funnel: z
    .string()
    .max(400)
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9_]{1,47}$/.test(s)) : undefined)),
});

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ page: string }> }) => {
  const { page } = await ctx.params;
  const user = await requireUser(req, page === "revenue" ? "view_revenue" : "view");
  const sp = searchParams(req);
  const q = rangeQuery.parse(sp);
  const db = pool();
  let data: Record<string, unknown>;
  switch (page) {
    case "overview":
      data = await overview(db, q);
      break;
    case "live":
      data = await livePage(db, q.env);
      break;
    case "revenue":
      data = await revenuePage(db, q);
      break;
    case "engagement":
      data = await engagementPage(db, q);
      break;
    case "retention":
      data = await retentionPage(db, q);
      break;
    case "gameplay":
      data = await gameplayPage(db, { ...q, ...gameplayExtra.parse(sp) });
      break;
    case "growth":
      data = await growthPage(db, q);
      break;
    case "servers":
      data = await serversPage(db, q);
      break;
    default:
      throw new HttpError(404, "unknown page");
  }
  // roles without revenue access never receive revenue figures from any page
  if (!can(user.role, "view_revenue")) {
    data = { ...redactRevenue(data), revenueHidden: true };
  }
  return json(data);
});
