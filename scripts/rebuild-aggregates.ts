/** Recomputes every aggregate from the base tables (safe to run any time). npm run rollup:rebuild */
import { pool } from "../src/server/db";
import { rebuildAll } from "../src/server/jobs/runner";

rebuildAll()
  .then(async (r) => {
    console.log("Rebuilt aggregates", r);
    await pool().end();
  })
  .catch(async (e) => {
    console.error(e.message);
    await pool().end().catch(() => undefined);
    process.exit(1);
  });
