import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { can, SESSION_COOKIE, userFromToken, type Permission, type SessionUser } from "./auth/auth";
import { env } from "./env";
import { takeToken } from "./ingest/keys";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(body: unknown, init?: number | ResponseInit) {
  const i = typeof init === "number" ? { status: init } : init;
  return NextResponse.json(body, { ...i, headers: { "Cache-Control": "no-store", ...(i?.headers ?? {}) } });
}

export function clientIp(req: NextRequest): string | null {
  if (env().TRUST_PROXY) {
    // the hosting proxy APPENDS the address it saw; earlier entries come from the client and can be forged
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) {
      const parts = fwd.split(",").map((x) => x.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  return null;
}

/**
 * Mutating dashboard requests must come from our own origin (defence in depth on top of the
 * SameSite=Strict session cookie).
 */
export function checkOrigin(req: NextRequest) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  const allowed = new URL(env().APP_URL).origin;
  const self = req.nextUrl.origin;
  if (!origin || (origin !== allowed && origin !== self)) throw new HttpError(403, "cross-origin request refused");
}

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  return userFromToken(jar.get(SESSION_COOKIE)?.value);
}

export async function requireUser(req: NextRequest, permission: Permission = "view"): Promise<SessionUser> {
  checkOrigin(req);
  const u = await currentUser();
  if (!u) throw new HttpError(401, "not signed in");
  if (!can(u.role, permission)) throw new HttpError(403, "your role does not allow this");
  // generous per-user API limit (protects the database from a runaway tab or script)
  if (!takeToken(`user:${u.id}`, 600)) throw new HttpError(429, "too many requests");
  return u;
}

/** Wraps a route handler: maps validation, permission and range errors to clean JSON responses. */
export function handler<C>(fn: (req: NextRequest, ctx: C) => Promise<Response>) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof ZodError) return json({ error: "invalid request", issues: err.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
      if (err instanceof RangeError) return json({ error: err.message }, 400);
      console.error("[api]", req.method, req.nextUrl.pathname, (err as Error).message);
      return json({ error: "internal error" }, 500);
    }
  };
}

export function searchParams(req: NextRequest): Record<string, string> {
  return Object.fromEntries(req.nextUrl.searchParams.entries());
}
