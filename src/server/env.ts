import { z } from "zod";

/**
 * Server-side configuration. Parsed once; a missing or weak secret stops the server at start-up
 * instead of running insecurely. Nothing here is ever sent to the browser.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: z.enum(["require", "disable", "no-verify"]).default("disable"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(50).default(10),
  // HMAC pepper that turns Roblox UserIds into pseudonymous player keys. Never change it after
  // launch: every player would look new.
  PLAYER_ID_PEPPER: z.string().min(32, "PLAYER_ID_PEPPER must be at least 32 characters"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  JOBS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  DISCORD_WEBHOOK_URL: z
    .string()
    .url()
    .refine((u) => /^https:\/\/(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)\/api\/webhooks\//.test(u), {
      message: "DISCORD_WEBHOOK_URL must be a Discord webhook URL",
    })
    .optional()
    .or(z.literal("").transform(() => undefined)),
  ROBLOX_UNIVERSE_ID: z.coerce.number().int().positive().optional().or(z.literal("").transform(() => undefined)),
  INGEST_MAX_BODY_BYTES: z.coerce.number().int().default(512 * 1024),
  INGEST_RATE_PER_KEY_PER_MIN: z.coerce.number().int().default(60000), // ~12/min per server: room for ~5000 servers
  INGEST_RATE_PER_SERVER_PER_MIN: z.coerce.number().int().default(120),
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server configuration — ${msg}`);
  }
  cached = parsed.data;
  return cached;
}

/** for tests */
export function resetEnvCache() {
  cached = null;
}

export function cookieSecure(): boolean {
  const e = env();
  if (e.COOKIE_SECURE !== undefined) return e.COOKIE_SECURE;
  return e.NODE_ENV === "production";
}
