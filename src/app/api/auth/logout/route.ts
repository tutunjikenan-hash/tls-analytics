import type { NextRequest } from "next/server";
import { logout, SESSION_COOKIE } from "@/server/auth/auth";
import { checkOrigin, clientIp, currentUser, handler, json } from "@/server/http";

export const runtime = "nodejs";

export const POST = handler(async (req: NextRequest) => {
  checkOrigin(req);
  const u = await currentUser();
  if (u) await logout(u.sessionId, u.id, clientIp(req));
  const res = json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
});
