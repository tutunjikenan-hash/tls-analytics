/**
 * Creates (or resets) a dashboard user.
 *   npm run user:create -- --email you@example.com --name "You" --role owner
 * The password is read from TLS_NEW_PASSWORD or prompted for (never passed on the command line, where
 * it would end up in shell history).
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { hashPassword, ROLES } from "../src/server/auth/auth";
import { pool } from "../src/server/db";

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string", default: "owner" }, reset: { type: "boolean", default: false } } });
  if (!values.email || !values.name) throw new Error("usage: --email <email> --name <name> [--role owner|admin|analyst|viewer] [--reset]");
  if (!ROLES.includes(values.role as (typeof ROLES)[number])) throw new Error(`role must be one of ${ROLES.join(", ")}`);
  let pw = process.env.TLS_NEW_PASSWORD;
  if (!pw) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    pw = await rl.question("Password (12+ characters): ");
    rl.close();
  }
  const hash = await hashPassword(pw);
  const { rows } = await pool().query(
    `INSERT INTO users (email, name, role, password_hash) VALUES (lower($1), $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = CASE WHEN $5 THEN EXCLUDED.password_hash ELSE users.password_hash END,
       role = CASE WHEN $5 THEN EXCLUDED.role ELSE users.role END, failed_logins = 0, locked_until = NULL
     RETURNING id, email, role, (xmax = 0) AS created`,
    [values.email, values.name, values.role, hash, values.reset],
  );
  const r = rows[0];
  console.log(r.created ? `Created ${r.role} ${r.email}` : values.reset ? `Reset password and role for ${r.email}` : `${r.email} already exists (use --reset to change the password)`);
  await pool().query(`INSERT INTO audit_log (action, target, details) VALUES ('user_created_cli', $1, $2)`, [r.email, { role: r.role, reset: values.reset }]);
  await pool().end();
}
main().catch(async (e) => {
  console.error(e.message);
  await pool().end().catch(() => undefined);
  process.exit(1);
});
