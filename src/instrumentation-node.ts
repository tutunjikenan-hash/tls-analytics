/**
 * Next.js start-up hook: runs once per server process.
 *  1. validates configuration (a missing secret stops the server instead of running insecurely)
 *  2. applies pending database migrations (RUN_MIGRATIONS, default true; advisory-locked)
 *  3. starts the background job runner (a single leader is elected through Postgres)
 */
export async function startNode() {
  const { env } = await import("./server/env");
  const e = env();
  if ((process.env.RUN_MIGRATIONS ?? "true") === "true") {
    const { migrate } = await import("./server/migrate");
    const ssl = e.DATABASE_SSL === "disable" ? undefined : e.DATABASE_SSL === "no-verify" ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
    await migrate(e.DATABASE_URL, ssl, (m) => console.log(`[migrate] ${m}`));
  }
  const { pool } = await import("./server/db");
  const { loadPepper } = await import("./server/pepper");
  await loadPepper(pool());
  await bootstrapOwner();
  const { startJobs } = await import("./server/jobs/runner");
  startJobs();
}

/**
 * First start on a hosting platform without a shell: if there are no users yet and
 * BOOTSTRAP_OWNER_EMAIL + BOOTSTRAP_OWNER_PASSWORD are set, create that owner once. Remove the two
 * variables afterwards (they are ignored as soon as any user exists).
 */
async function bootstrapOwner() {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL;
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!email || !password) return; // without a password the owner is created on the first-time setup screen
  const { pool } = await import("./server/db");
  const { hashPassword, audit } = await import("./server/auth/auth");
  const { rows } = await pool().query(`SELECT count(*)::int AS n FROM users`);
  if (rows[0].n > 0) {
    console.warn("[bootstrap] users already exist: BOOTSTRAP_OWNER_* ignored — remove these variables");
    return;
  }
  const hash = await hashPassword(password);
  await pool().query(`INSERT INTO users (email, name, role, password_hash) VALUES (lower($1), 'Owner', 'owner', $2) ON CONFLICT DO NOTHING`, [email, hash]);
  await audit(null, "owner_bootstrapped", email.toLowerCase());
  console.log(`[bootstrap] created owner ${email} — now remove BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD`);
}
