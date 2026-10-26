import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit, hashPassword, ROLES } from "@/server/auth/auth";
import { pool } from "@/server/db";
import { clientIp, handler, HttpError, json, requireUser } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireUser(req, "manage_users");
  const { rows } = await pool().query(
    `SELECT id, email, name, role, created_at, last_login_at, disabled_at, locked_until FROM users ORDER BY created_at`,
  );
  return json({ users: rows });
});

const create = z.object({
  email: z.string().email().max(200),
  name: z.string().trim().min(1).max(80),
  role: z.enum(ROLES),
  password: z.string().min(12).max(200),
});

export const POST = handler(async (req: NextRequest) => {
  const u = await requireUser(req, "manage_users");
  const b = create.parse(await req.json());
  const hash = await hashPassword(b.password);
  const { rows } = await pool()
    .query(`INSERT INTO users (email, name, role, password_hash) VALUES (lower($1), $2, $3, $4) RETURNING id, email, name, role, created_at`, [b.email, b.name, b.role, hash])
    .catch((err) => {
      if (String(err.message).includes("users_email_key")) throw new HttpError(409, "a user with that email already exists");
      throw err;
    });
  await audit(u.id, "user_created", rows[0].email, { role: b.role }, clientIp(req));
  return json(rows[0], 201);
});
