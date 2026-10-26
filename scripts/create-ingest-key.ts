/**
 * Creates an ingest key for game servers (or the simulator) and prints it once.
 *   npm run key:create -- --name "Production servers" --env production,studio
 */
import { parseArgs } from "node:util";
import { pool } from "../src/server/db";
import { generateKey } from "../src/server/ingest/keys";
import { ENVIRONMENTS } from "../src/server/ingest/schema";

async function main() {
  const { values } = parseArgs({ options: { name: { type: "string" }, env: { type: "string", default: "production,studio" } } });
  if (!values.name) throw new Error('usage: --name "<label>" [--env production,studio,simulation]');
  const envs = values.env!.split(",").map((s) => s.trim());
  for (const e of envs) if (!ENVIRONMENTS.includes(e as (typeof ENVIRONMENTS)[number])) throw new Error(`unknown environment ${e}`);
  const k = generateKey();
  await pool().query(`INSERT INTO ingest_keys (name, key_hash, key_prefix, environments) VALUES ($1,$2,$3,$4)`, [values.name, k.hash, k.prefix, envs]);
  await pool().query(`INSERT INTO audit_log (action, target, details) VALUES ('ingest_key_created_cli', $1, $2)`, [values.name, { environments: envs, prefix: k.prefix }]);
  console.log(`Ingest key for ${envs.join(", ")} (shown once, store it as a Roblox secret):\n\n${k.key}\n`);
  await pool().end();
}
main().catch(async (e) => {
  console.error(e.message);
  await pool().end().catch(() => undefined);
  process.exit(1);
});
