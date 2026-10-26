import { env } from "../env";

export interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export const COLORS = { info: 0x3b82f6, warning: 0xf59e0b, critical: 0xef4444, ok: 0x22c55e, report: 0x8b5cf6 } as const;

/**
 * Posts to the configured Discord webhook. Returns null on success or an error message. Never throws,
 * so a Discord outage cannot break alert evaluation. The webhook URL is a secret (server env only).
 */
export async function postDiscord(embeds: DiscordEmbed[], content?: string): Promise<string | null> {
  const url = env().DISCORD_WEBHOOK_URL;
  if (!url) return "DISCORD_WEBHOOK_URL is not configured";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "TLS Analytics", content, embeds: embeds.slice(0, 10), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) return "Discord rate limited the webhook";
    if (!res.ok) return `Discord responded ${res.status}`;
    return null;
  } catch (err) {
    return `Discord request failed: ${(err as Error).message}`;
  }
}
