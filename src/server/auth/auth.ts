import { createHash, createHmac, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import { cookieSecure, env } from "../env";

/**
 * Dashboard authentication.
 *  - passwords: bcrypt (cost 12), minimum 12 characters
 *  - sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie; only its SHA-256 is stored,
 *    so a database leak does not leak usable sessions; sessions are revocable server-side
 *  - brute force: 10 requests/min per IP on the login route; 10 failed logins lock the account for 15 minutes
 *  - roles: viewer < analyst < admin < owner (see can())
 */

export const ROLES = ["viewer", "analyst", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];
export const SESSION_COOKIE = "tls_session";

export type Permission =
  | "view" // dashboards except revenue
  | "view_revenue"
  | "export"
  | "manage_alerts"
  | "manage_settings"
  | "manage_keys"
  | "reconcile"
  | "manage_users"
  | "view_audit";

const MIN_ROLE: Record<Permission, Role> = {
  view: "viewer",
  view_revenue: "analyst",
  export: "analyst",
  manage_alerts: "admin",
  manage_settings: "admin",
  manage_keys: "admin",
  reconcile: "admin",
  view_audit: "admin",
  manage_users: "owner",
};

export function can(role: Role, p: Permission): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(MIN_ROLE[p]);
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
}

export async function hashPassword(pw: string): Promise<string> {
  validatePassword(pw);
  return bcrypt.hash(pw, 12);
}

export function validatePassword(pw: string) {
  if (pw.length < 12) throw new Error("Password must be at least 12 characters");
  if (pw.length > 200) throw new Error("Password is too long");
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Pseudonymous IP for the audit log and rate limiting (never stored raw). */
export function ipHash(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHmac("sha256", env().PLAYER_ID_PEPPER).update(`ip:${ip}`).digest("hex").slice(0, 16);
}

// Lockout is a backstop against slow distributed guessing; fast guessing is stopped first by the
// per-IP limit on the login route. A higher threshold keeps an attacker from locking the owner out
// with a handful of tries.
const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;
// a real bcrypt hash (cost 12) of a random string, made once: checking an unknown email against it
// takes as long as a real check, so response time does not reveal which emails exist
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hash(randomBytes(16).toString("hex"), 12));

export type LoginResult = { ok: true; token: string; user: SessionUser; expiresAt: Date } | { ok: false; reason: "invalid" | "locked" | "disabled" };

export async function login(email: string, password: string, meta: { ip?: string | null; userAgent?: string | null }): Promise<LoginResult> {
  const db = pool();
  const { rows } = await db.query(
    `SELECT id, email, name, role, password_hash, disabled_at, locked_until, failed_logins FROM users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  const u = rows[0];
  if (!u) {
    await bcrypt.compare(password, await getDummyHash());
    await audit(null, "login_failed", email.trim().toLowerCase(), { reason: "unknown_email" }, meta.ip);
    return { ok: false, reason: "invalid" };
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    await audit(u.id, "login_blocked", u.email, { reason: "locked" }, meta.ip);
    return { ok: false, reason: "locked" };
  }
  const good = await bcrypt.compare(password, u.password_hash);
  if (!good) {
    const fails = Number(u.failed_logins) + 1;
    if (fails >= LOCK_AFTER) {
      await db.query(`UPDATE users SET failed_logins = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1`, [u.id, LOCK_MINUTES]);
    } else {
      await db.query(`UPDATE users SET failed_logins = $2 WHERE id = $1`, [u.id, fails]);
    }
    await audit(u.id, "login_failed", u.email, { reason: "bad_password", locked: fails >= LOCK_AFTER }, meta.ip);
    return { ok: false, reason: fails >= LOCK_AFTER ? "locked" : "invalid" };
  }
  if (u.disabled_at) {
    await audit(u.id, "login_blocked", u.email, { reason: "disabled" }, meta.ip);
    return { ok: false, reason: "disabled" };
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env().SESSION_TTL_HOURS * 3600_000);
  const { rows: s } = await db.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at, user_agent, ip_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [u.id, hashToken(token), expiresAt, (meta.userAgent ?? "").slice(0, 200), ipHash(meta.ip)],
  );
  await db.query(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [u.id]);
  await audit(u.id, "login", u.email, {}, meta.ip);
  return { ok: true, token, expiresAt, user: { id: u.id, email: u.email, name: u.name, role: u.role, sessionId: s[0].id } };
}

const touched = new Map<string, number>();

export async function userFromToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length < 30 || token.length > 100) return null;
  const { rows } = await pool().query(
    `SELECT s.id AS sid, u.id, u.email, u.name, u.role FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  const last = touched.get(r.sid) ?? 0;
  if (Date.now() - last > 60_000) {
    touched.set(r.sid, Date.now());
    void pool().query(`UPDATE user_sessions SET last_seen_at = now() WHERE id = $1`, [r.sid]).catch(() => undefined);
  }
  return { id: r.id, email: r.email, name: r.name, role: r.role, sessionId: r.sid };
}

export async function logout(sessionId: string, userId: string, ip?: string | null) {
  await pool().query(`UPDATE user_sessions SET revoked_at = now() WHERE id = $1`, [sessionId]);
  await audit(userId, "logout", null, {}, ip);
}

export async function audit(userId: string | null, action: string, target: string | null, details: Record<string, unknown> = {}, ip?: string | null) {
  await pool()
    .query(`INSERT INTO audit_log (user_id, action, target, details, ip_hash) VALUES ($1,$2,$3,$4,$5)`, [userId, action, target, details, ipHash(ip)])
    .catch((err) => console.error("[audit] write failed", (err as Error).message));
}

export function sessionCookie(token: string, expiresAt: Date) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "strict" as const,
    path: "/",
    expires: expiresAt,
  };
}
