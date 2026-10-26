import { z } from "zod";

/**
 * The wire format the Roblox servers send (see roblox/TLSAnalytics). Everything is validated here;
 * one bad event is rejected on its own and never sinks the rest of the batch.
 */

export const ENVIRONMENTS = ["production", "studio", "simulation"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const uuid = z.string().uuid();
// Roblox ids (users, places, products, passes) are 64-bit; JSON numbers are exact up to 2^53
const robloxId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Studio "local server" test players have negative UserIds (-1, -2, ...)
const robloxUserId = z.number().int().refine((n) => n !== 0 && Math.abs(n) <= Number.MAX_SAFE_INTEGER, "invalid user id");
const shortText = (max: number) => z.string().trim().min(1).max(max);
const msTimestamp = z.number().int().positive();

export const envelopeSchema = z.object({
  v: z.literal(1),
  env: z.enum(ENVIRONMENTS),
  serverId: z.string().min(1).max(80),
  placeId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  placeVersion: z.number().int().nonnegative().max(1e9).optional(),
  serverKind: z.enum(["public", "reserved", "private", "studio", "simulation"]).optional(),
  sentAt: msTimestamp,
  events: z.array(z.unknown()).min(1).max(500),
});
export type Envelope = z.infer<typeof envelopeSchema>;

/** Roblox's JSONEncode writes an empty table as [], so an empty array is accepted as an empty object. */
const obj = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (Array.isArray(v) && v.length === 0 ? {} : v), schema);

const baseEvent = z.object({
  id: uuid,
  ts: msTimestamp,
});

const heartbeatPlayer = z.object({
  sid: uuid,
  uid: robloxUserId,
  stage: shortText(64).optional(),
});

/** gameplay event names: snake_case, configurable in roblox/TLSAnalytics/Config.luau */
export const gameEventName = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, "event names are snake_case, 2-48 chars");

const propsSchema = z
  .record(z.string().max(40), z.union([z.string().max(200), z.number().finite(), z.boolean()]))
  .refine((p) => Object.keys(p).length <= 20, "at most 20 props");

export const eventSchema = z.discriminatedUnion("type", [
  baseEvent.extend({ type: z.literal("server_start"), d: obj(z.object({}).passthrough()).optional() }),
  baseEvent.extend({
    type: z.literal("server_heartbeat"),
    d: z.object({
      players: z.array(heartbeatPlayer).max(250),
      fps: z.number().finite().min(0).max(1000).optional(),
      memMb: z.number().finite().min(0).max(1e6).optional(),
      uptimeSec: z.number().int().min(0).max(1e8).optional(),
    }),
  }),
  baseEvent.extend({
    type: z.literal("server_stop"),
    d: obj(z.object({ reason: shortText(40).optional() })).optional(),
  }),
  baseEvent.extend({
    type: z.literal("session_start"),
    sid: uuid,
    uid: robloxUserId,
    d: obj(z
      .object({
        teleportIn: z.boolean().optional(),
        referred: z.boolean().optional(),
        country: z.string().regex(/^[A-Z]{2}$/).optional(),
      }))
      .optional(),
  }),
  baseEvent.extend({
    type: z.literal("session_end"),
    sid: uuid,
    uid: robloxUserId,
    d: obj(z
      .object({
        reason: z.enum(["left", "server_shutdown"]).optional(),
        durationSec: z.number().finite().min(0).max(7 * 86400).optional(),
      }))
      .optional(),
  }),
  baseEvent.extend({
    type: z.literal("purchase"),
    uid: robloxUserId,
    sid: uuid.optional(),
    d: z.object({
      purchaseId: shortText(100),
      kind: z.enum(["developer_product", "game_pass"]),
      productId: robloxId,
      productName: shortText(100).optional(),
      robux: z.number().int().min(0).max(10_000_000),
      priceSource: z.enum(["receipt_currency_spent", "catalog_list_price"]),
      status: z.enum(["confirmed", "pending_verification"]),
    }),
  }),
  baseEvent.extend({
    type: z.literal("game"),
    uid: robloxUserId.optional(),
    sid: uuid.optional(),
    d: z.object({
      name: gameEventName,
      runId: shortText(64).optional(),
      chapter: shortText(32).optional(),
      stage: shortText(32).optional(),
      area: shortText(64).optional(),
      value: z.number().finite().optional(),
      props: obj(propsSchema).optional(),
    }),
  }),
  baseEvent.extend({
    type: z.literal("counter"),
    d: z.object({ name: gameEventName, value: z.number().int().min(0).max(1e6) }),
  }),
]);
export type IngestEvent = z.infer<typeof eventSchema>;

/** Events stamped too far in the past or future come from a broken clock and are rejected. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 3600 * 1000;
export const MAX_EVENT_FUTURE_MS = 5 * 60 * 1000;
/** A request's sentAt must be this close to now (replay window). */
export const MAX_SENT_SKEW_MS = 15 * 60 * 1000;
