import { randomBytes } from "node:crypto";
import type { Queryable } from "./db";
import { env } from "./env";

/**
 * The secret that turns Roblox UserIds into pseudonymous player keys.
 * PLAYER_ID_PEPPER (env) wins if set; otherwise one is generated on first start and kept in the
 * database (settings key "player_id_pepper", never returned by any API). It must never change once
 * players have been recorded, or every player looks new.
 */
// process-wide: Next.js bundles start-up code and API routes separately, so a module variable
// would not be shared between them (same approach as the database pool)
declare global {
  // eslint-disable-next-line no-var
  var __tlsPepper: string | undefined;
}

export async function loadPepper(db: Queryable): Promise<string> {
  const fromEnv = env().PLAYER_ID_PEPPER;
  if (fromEnv) return (globalThis.__tlsPepper = fromEnv);
  if (globalThis.__tlsPepper) return globalThis.__tlsPepper;
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('player_id_pepper', to_jsonb($1::text)) ON CONFLICT (key) DO NOTHING`,
    [randomBytes(33).toString("base64url")],
  );
  const { rows } = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'player_id_pepper'`);
  globalThis.__tlsPepper = rows[0].value;
  return globalThis.__tlsPepper;
}

/** For synchronous callers after start-up (the server loads it before serving). */
export function pepperSync(): string {
  const fromEnv = env().PLAYER_ID_PEPPER;
  if (fromEnv) return fromEnv;
  if (!globalThis.__tlsPepper) throw new Error("player id pepper not loaded yet");
  return globalThis.__tlsPepper;
}
