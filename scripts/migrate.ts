/** CLI: npm run db:migrate */
import { join } from "node:path";
import { migrate } from "../src/server/migrate";

export { migrate };

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const mode = process.env.DATABASE_SSL ?? "disable";
  const ssl = mode === "disable" ? undefined : mode === "no-verify" ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
  migrate(url, ssl, console.log, process.env.MIGRATIONS_DIR ?? join(__dirname, "..", "db", "migrations")).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
