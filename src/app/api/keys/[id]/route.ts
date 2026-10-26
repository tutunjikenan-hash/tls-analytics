import type { NextRequest } from "next/server";
import { audit } from "@/server/auth/auth";
import { pool } from "@/server/db";
import { clientIp, handler, HttpError, json, requireUser } from "@/server/http";
import { clearKeyCache } from "@/server/ingest/keys";

export const runtime = "nodejs";

/** Revokes an ingest key (game servers using it get 401 within 30 s). */
export const DELETE = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const u = await requireUser(req, "manage_keys");
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "bad id");
  const { rowCount } = await pool().query(`UPDATE ingest_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
  clearKeyCache();
  await audit(u.id, "ingest_key_revoked", id, {}, clientIp(req));
  return json({ ok: true, changed: rowCount });
});
