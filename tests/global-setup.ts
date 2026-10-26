/**
 * Creates a throw-away test database (TEST_DATABASE_URL's database name gets a _test suffix if it
 * does not have one), applies the migrations, and drops it afterwards. Tests never touch the
 * production database: they refuse to run unless the database name ends in "_test".
 */
import { Client } from "pg";
import { migrate } from "../src/server/migrate";

const DEFAULT = "postgres://postgres@127.0.0.1:54329/tls_test";

export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? DEFAULT);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith("_test")) throw new Error(`refusing to run tests against "${dbName}" — the test database name must end in _test`);
  const admin = new URL(url.toString());
  admin.pathname = "/postgres";
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await c.query(`CREATE DATABASE "${dbName}"`);
  await c.end();
  await migrate(url.toString(), undefined, () => undefined);
  process.env.DATABASE_URL = url.toString();
  return async () => {
    const c2 = new Client({ connectionString: admin.toString() });
    await c2.connect();
    await c2.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await c2.end();
  };
}
