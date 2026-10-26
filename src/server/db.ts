import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";

/** Anything that can run a query: the pool or a client inside a transaction. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

declare global {
  // eslint-disable-next-line no-var
  var __tlsPool: Pool | undefined;
}

export function pool(): Pool {
  if (!globalThis.__tlsPool) {
    const e = env();
    const ssl =
      e.DATABASE_SSL === "disable" ? undefined : e.DATABASE_SSL === "no-verify" ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
    globalThis.__tlsPool = new Pool({
      connectionString: e.DATABASE_URL,
      max: e.DATABASE_POOL_MAX,
      ssl,
      idleTimeoutMillis: 30_000,
      // every connection works in UTC; reporting time zones are applied explicitly in SQL
      options: "-c timezone=UTC -c statement_timeout=30000",
    });
    globalThis.__tlsPool.on("error", (err) => console.error("[db] idle client error", err.message));
  }
  return globalThis.__tlsPool;
}

export async function q<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
  const res = await pool().query<R>(text, params);
  return res.rows;
}

export async function q1<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<R | null> {
  const rows = await q<R>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs fn only if this process holds the named Postgres advisory lock, so background jobs run on
 * exactly one app instance even when several are deployed. Returns false when another instance holds it.
 */
export async function withLeaderLock(name: string, fn: () => Promise<void>): Promise<boolean> {
  const client = await pool().connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [name]);
    if (!rows[0]?.ok) return false;
    try {
      await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [name]).catch(() => undefined);
    }
    return true;
  } finally {
    client.release();
  }
}
