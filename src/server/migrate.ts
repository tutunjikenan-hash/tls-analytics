/**
 * Applies db/migrations/*.sql in order, each in its own transaction, recording what ran in
 * schema_migrations. Holds a Postgres advisory lock, so several instances starting at once are safe.
 * Runs at server start (RUN_MIGRATIONS, default true) and from the CLI: npm run db:migrate
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

/** Directory with the .sql files: MIGRATIONS_DIR, else ./db/migrations under the working directory. */
export function migrationsDir() {
  return process.env.MIGRATIONS_DIR ?? join(process.cwd(), "db", "migrations");
}

export async function migrate(databaseUrl: string, ssl?: unknown, log = console.log, dir = migrationsDir()): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl, ssl: ssl as never });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('tls_migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
        log(`applied ${f}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${f} failed: ${(err as Error).message}`);
      }
    }
    if (applied.length === 0) log("database is up to date");
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('tls_migrations'))").catch(() => undefined);
    await client.end();
  }
  return applied;
}

