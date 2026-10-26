/**
 * Revenue redaction for roles without "view_revenue". Applied to every response a viewer can get,
 * recursively, so a new field with a revenue-like name is hidden by default instead of leaking.
 */
const REVENUE_KEY = /revenue|robux|purchase|payer|paying|arp(d|p)au|arppu|conversion/i;
const REVENUE_REPORTED = new Set(["lifetime_revenue_robux", "premium_payouts_robux"]);
export const REVENUE_ALERTS = new Set(["revenue_spike", "purchase_errors"]);

export function redactRevenue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactRevenue(v)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REVENUE_KEY.test(k) || REVENUE_REPORTED.has(k)) continue;
      out[k] = redactRevenue(v);
    }
    return out as T;
  }
  return value;
}
