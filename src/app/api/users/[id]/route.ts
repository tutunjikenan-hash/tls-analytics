import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit, hashPassword, ROLES } from "@/server/auth/auth";
import { pool, tx } from "@/server/db";
import { clientIp, handler, HttpError, json, requireUser } from "@/server/http";

export const runtime = "nodejs";

const patch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  role: z.enum(ROLES).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(12).max(200).optional(),
  unlock: z.literal(true).optional(),
});

export const PATCH = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const me = await requireUser(req, "manage_users");
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "bad id");
  const b = patch.parse(await req.json());
  const hash = b.password ? await hashPassword(b.password) : null;
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT id, role FROM users WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw new HttpError(404, "no such user");
    // never leave the dashboard without an active owner
    const losingOwner = rows[0].role === "owner" && ((b.role && b.role !== "owner") || b.disabled === true);
    if (losingOwner) {
      const { rows: o } = await c.query(`SELECT count(*) AS n FROM users WHERE role = 'owner' AND disabled_at IS NULL AND id <> $1`, [id]);
      if (Number(o[0].n) === 0) throw new HttpError(409, "this is the last active owner");
    }
    await c.query(
      `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role),
         disabled_at = CASE WHEN $4::boolean IS NULL THEN disabled_at WHEN $4 THEN COALESCE(disabled_at, now()) ELSE NULL END,
         password_hash = COALESCE($5, password_hash),
         locked_until = CASE WHEN $6::boolean THEN NULL ELSE locked_until END,
         failed_logins = CASE WHEN $6::boolean THEN 0 ELSE failed_logins END
       WHERE id = $1`,
      [id, b.name ?? null, b.role ?? null, b.disabled ?? null, hash, b.unlock === true],
    );
    // a disabled user, a role change or a password reset ends that user's existing sessions
    if (b.disabled || b.role || hash) await c.query(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
  });
  const { password: _p, ...logged } = b;
  await audit(me.id, "user_updated", id, { ...logged, passwordReset: !!hash }, clientIp(req));
  return json({ ok: true });
});
