import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit, hashPassword, login, sessionCookie } from "@/server/auth/auth";
import { pool } from "@/server/db";
import { checkOrigin, clientIp, handler, HttpError, json } from "@/server/http";
import { takeToken } from "@/server/ingest/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * First-time setup: while the dashboard has no users, the owner creates their account here.
 * Only the email in BOOTSTRAP_OWNER_EMAIL can be used, so a stranger who finds the address first
 * cannot claim it. Closed for good as soon as any user exists.
 */
async function setupOpen(): Promise<boolean> {
  if (!process.env.BOOTSTRAP_OWNER_EMAIL) return false;
  const { rows } = await pool().query(`SELECT count(*)::int AS n FROM users`);
  return rows[0].n === 0;
}

export const GET = handler(async () => json({ needed: await setupOpen() }));

const body = z.object({ name: z.string().trim().min(1).max(80), email: z.string().email().max(200), password: z.string().min(12).max(200) });

export const POST = handler(async (req: NextRequest) => {
  checkOrigin(req);
  const ip = clientIp(req);
  if (!takeToken(`setup-ip:${ip ?? "unknown"}`, 5)) throw new HttpError(429, "too many attempts, wait a minute");
  const b = body.parse(await req.json());
  if (!(await setupOpen())) throw new HttpError(403, "setup is already complete — sign in instead");
  if (b.email.trim().toLowerCase() !== String(process.env.BOOTSTRAP_OWNER_EMAIL).trim().toLowerCase()) {
    throw new HttpError(403, "use the owner email configured for this dashboard");
  }
  const hash = await hashPassword(b.password);
  const ins = await pool().query(
    `INSERT INTO users (email, name, role, password_hash) SELECT lower($1), $2, 'owner', $3 WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id`,
    [b.email, b.name, hash],
  );
  if (ins.rowCount === 0) throw new HttpError(403, "setup is already complete — sign in instead");
  await audit(ins.rows[0].id, "owner_setup", b.email.toLowerCase(), {}, ip);
  const r = await login(b.email, b.password, { ip, userAgent: req.headers.get("user-agent") });
  if (!r.ok) return json({ ok: true, signedIn: false });
  const res = json({ ok: true, signedIn: true });
  res.cookies.set(sessionCookie(r.token, r.expiresAt));
  return res;
});
