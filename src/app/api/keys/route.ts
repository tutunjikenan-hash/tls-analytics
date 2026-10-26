import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/auth/auth";
import { pool } from "@/server/db";
import { clientIp, handler, json, requireUser } from "@/server/http";
import { ENVIRONMENTS } from "@/server/ingest/schema";
import { generateKey } from "@/server/ingest/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireUser(req, "manage_keys");
  const { rows } = await pool().query(
    `SELECT id, name, key_prefix, environments, created_at, last_used_at, revoked_at FROM ingest_keys ORDER BY created_at DESC`,
  );
  return json({ keys: rows });
});

const create = z.object({ name: z.string().trim().min(1).max(60), environments: z.array(z.enum(ENVIRONMENTS)).min(1) });

/** Creates an ingest key. The full key is returned once and never stored (only its SHA-256). */
export const POST = handler(async (req: NextRequest) => {
  const u = await requireUser(req, "manage_keys");
  const b = create.parse(await req.json());
  const k = generateKey();
  const { rows } = await pool().query(
    `INSERT INTO ingest_keys (name, key_hash, key_prefix, environments, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, key_prefix, environments, created_at`,
    [b.name, k.hash, k.prefix, [...new Set(b.environments)], u.id],
  );
  await audit(u.id, "ingest_key_created", rows[0].id, { name: b.name, environments: b.environments, prefix: k.prefix }, clientIp(req));
  return json({ ...rows[0], key: k.key }, 201);
});
