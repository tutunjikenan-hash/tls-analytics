import type { NextRequest } from "next/server";
import { z } from "zod";
import { login, sessionCookie } from "@/server/auth/auth";
import { checkOrigin, clientIp, handler, HttpError, json } from "@/server/http";
import { takeToken } from "@/server/ingest/keys";

export const runtime = "nodejs";

const body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export const POST = handler(async (req: NextRequest) => {
  checkOrigin(req);
  const ip = clientIp(req);
  if (!takeToken(`login-ip:${ip ?? "unknown"}`, 10)) throw new HttpError(429, "too many sign-in attempts, wait a minute");
  const { email, password } = body.parse(await req.json());
  const r = await login(email, password, { ip, userAgent: req.headers.get("user-agent") });
  if (!r.ok) {
    const msg = r.reason === "locked" ? "too many failed attempts — the account is locked for 15 minutes" : r.reason === "disabled" ? "this account is disabled" : "wrong email or password";
    return json({ error: msg }, r.reason === "invalid" ? 401 : 403);
  }
  const res = json({ ok: true, user: { name: r.user.name, email: r.user.email, role: r.user.role } });
  res.cookies.set(sessionCookie(r.token, r.expiresAt));
  return res;
});
