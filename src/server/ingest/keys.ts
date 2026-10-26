import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Queryable } from "../db";
import type { Environment } from "./schema";

/**
 * Ingestion keys. The game servers send `Authorization: Bearer <key>`; the key itself lives in
 * Roblox's Secrets store (HttpService:GetSecret) and is never readable by scripts or clients.
 * Only the SHA-256 of a key is stored here.
 */

export function generateKey(): { key: string; prefix: string; hash: Buffer } {
  const key = `tls_${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

export function hashKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export interface IngestKey {
  id: string;
  name: string;
  environments: Environment[];
}

const cache = new Map<string, { key: IngestKey | null; at: number }>();
const CACHE_MS = 30_000;

export async function verifyKey(db: Queryable, presented: string): Promise<IngestKey | null> {
  if (!/^tls_[A-Za-z0-9_-]{40,60}$/.test(presented)) return null;
  const hash = hashKey(presented);
  const ck = hash.toString("hex");
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.key;
  const { rows } = await db.query<{ id: string; name: string; environments: Environment[]; key_hash: Buffer }>(
    "SELECT id, name, environments, key_hash FROM ingest_keys WHERE key_hash = $1 AND revoked_at IS NULL",
    [hash],
  );
  const row = rows[0];
  const key = row && timingSafeEqual(row.key_hash, hash) ? { id: row.id, name: row.name, environments: row.environments } : null;
  cache.set(ck, { key, at: Date.now() });
  return key;
}

export function clearKeyCache() {
  cache.clear();
}

/** Roblox UserId -> pseudonymous, stable player key (HMAC-SHA256 with the server-side pepper). */
export function playerKey(pepper: string, userId: number): string {
  return createHmac("sha256", pepper).update(`roblox:${userId}`).digest("hex").slice(0, 24);
}

// ---------- rate limiting (token buckets, per app instance) ----------------------------------------
interface Bucket {
  tokens: number;
  at: number;
}
const buckets = new Map<string, Bucket>();

/** true if allowed. ratePerMin tokens refill continuously; burst = one minute's worth. */
export function takeToken(id: string, ratePerMin: number, now = Date.now()): boolean {
  const b = buckets.get(id) ?? { tokens: ratePerMin, at: now };
  // a clock that steps backwards (NTP adjustment) must never drain the bucket
  const refill = (Math.max(0, now - b.at) / 60_000) * ratePerMin;
  b.tokens = Math.min(ratePerMin, b.tokens + refill);
  b.at = Math.max(b.at, now);
  if (b.tokens < 1) {
    buckets.set(id, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(id, b);
  if (buckets.size > 50_000) {
    // drop the oldest half to bound memory
    const keys = [...buckets.keys()].slice(0, 25_000);
    for (const k of keys) buckets.delete(k);
  }
  return true;
}

export function resetRateLimits() {
  buckets.clear();
}
