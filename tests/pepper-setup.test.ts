import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { resetDb } from "./helpers";

describe("generated pepper", () => {
  beforeEach(resetDb);

  it("is created once, stored, never exposed by settings, and stable across restarts", async () => {
    const saved = process.env.PLAYER_ID_PEPPER;
    delete process.env.PLAYER_ID_PEPPER;
    resetEnvCache();
    try {
      await pool().query(`DELETE FROM settings WHERE key = 'player_id_pepper'`);
      const mod1 = await import("@/server/pepper?first" as string).catch(() => import("@/server/pepper"));
      const a = await mod1.loadPepper(pool());
      expect(a.length).toBeGreaterThanOrEqual(40);
      // a second process (fresh cache) reads the same value
      const { rows } = await pool().query(`SELECT value FROM settings WHERE key = 'player_id_pepper'`);
      expect(rows[0].value).toBe(a);
      const { getSettings } = await import("@/server/settings");
      expect(JSON.stringify(await getSettings(pool(), true))).not.toContain(a);
    } finally {
      process.env.PLAYER_ID_PEPPER = saved;
      resetEnvCache();
    }
  });
});

describe("DATABASE_URL cleanup", () => {
  it("extracts the URL from common copy-paste shapes", async () => {
    const { cleanDatabaseUrl } = await import("@/server/env");
    const u = "postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
    for (const v of [u, ` ${u}\n`, `DATABASE_URL='${u}'`, `DATABASE_URL="${u}"`, `psql '${u}'`, `'${u}'`]) expect(cleanDatabaseUrl(v)).toBe(u);
  });
});
