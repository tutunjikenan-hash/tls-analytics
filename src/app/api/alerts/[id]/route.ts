import type { NextRequest } from "next/server";
import { audit } from "@/server/auth/auth";
import { pool } from "@/server/db";
import { clientIp, handler, HttpError, json, requireUser } from "@/server/http";

export const runtime = "nodejs";

/** acknowledge an alert */
export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const u = await requireUser(req, "view");
  const { id } = await ctx.params;
  if (!/^\d{1,18}$/.test(id)) throw new HttpError(400, "bad id");
  const { rowCount } = await pool().query(`UPDATE alert_events SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 AND acknowledged_at IS NULL`, [id, u.id]);
  await audit(u.id, "alert_acknowledged", id, {}, clientIp(req));
  return json({ ok: true, changed: rowCount });
});
