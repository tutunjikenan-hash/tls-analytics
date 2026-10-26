# Purchases and revenue

## Developer products: ProcessReceipt

Roblox allows exactly one `ProcessReceipt` callback, and a callback cannot be read back from another
script, so it can't be wrapped from outside. The integration is **one line** in
`ServerScriptService.LastStop.ShopService`, at the place where the handler is assigned
(currently `MarketplaceService.ProcessReceipt = processReceipt`, near line 1596):

```lua
-- before
MarketplaceService.ProcessReceipt = processReceipt

-- after
local tlsModule = game:GetService("ServerScriptService"):FindFirstChild("TLSAnalytics")
local okAnalytics, TLSAnalytics = false, nil
if tlsModule then
	okAnalytics, TLSAnalytics = pcall(require, tlsModule)
end
MarketplaceService.ProcessReceipt = (okAnalytics and TLSAnalytics) and TLSAnalytics.wrapProcessReceipt(processReceipt) or processReceipt
```

What the wrapper guarantees (`TLSAnalytics.wrapProcessReceipt` in `init.luau`):

- The game's own handler runs **first and unchanged**, and its result is **returned unchanged**.
  Grants, saves, the `Receipts` idempotency list and `NotProcessedYet` retries behave exactly as before.
- A purchase is recorded **only** when the handler returned `PurchaseGranted`. It is queued in a
  separate thread, so analytics can never delay or fail a receipt.
- If the handler throws, the error is re-raised exactly as before (Roblox retries the receipt) and a
  `receipt_error` counter is recorded for the alert.
- `NotProcessedYet` adds a `receipt_not_processed` counter (shown on the Revenue page).
- Amount: `receipt.CurrencySpent` (what the buyer actually paid). Product name: `GetProductInfo`.
- **Idempotent**: the dashboard keys purchases by `PurchaseId`. Roblox re-delivering a receipt, a
  retried HTTP request, or the handler's "already granted" path never count twice.
- A receipt granted while the client is still starting is queued and sent once it has started.
- If the analytics module is missing or broken, this falls back to the plain handler without
  waiting, so purchases are unaffected.

The Studio receipt test inside ShopService calls `processReceipt` directly, so test receipts are not
recorded. Real Studio test purchases go to the `studio` environment.

## Game passes

Recorded by `TLSAnalytics` itself (no ShopService change): on
`PromptGamePassPurchaseFinished(player, passId, true)` it confirms ownership with
`UserOwnsGamePassAsync` (tries after 0, 5 and 15 s). Only then is the purchase `confirmed`. If
Roblox's ownership cache hasn't caught up, it is sent as `pending_verification` (**not counted as
revenue**, shown as pending) and re-checked after 1 and 3 minutes; a later confirmation upgrades the
same purchase. Each player can own a pass once, so the purchase id is `gp:<player>:<passId>`.

If a player who already owns a pass is shown the prompt, Roblox should report it as not purchased; if
it ever reported `true`, ownership would be recorded once (keyed by player + pass, so never twice).

The price is the pass's catalog price (`PriceInRobux`) because Roblox doesn't tell the server what was
paid for a pass; it's labelled `catalog_list_price`.

## Gross, estimated, verified

| Figure | Meaning |
|---|---|
| Gross | Robux the buyer spent (confirmed, not refunded) |
| Estimated creator earnings | Gross × creator share (Settings, default 0.7). An estimate only. |
| Verified earnings | Set only by reconciliation with official records. Empty until then. |

Not visible to game servers and never shown as measured: Premium Payouts, private-server
subscriptions, UGC/avatar sales, commissions, and Roblox's pending period, refunds and chargebacks.

## Reconciliation

Settings → *Reconcile revenue* (admin). Paste rows from an official export (Creator Hub sales /
transactions): `purchaseId, verifiedCreatorRobux, refunded`. Applying it recomputes every chart,
report and export within about a minute. *Check rows* shows how many match a
recorded purchase without changing anything; *Apply* stores verified amounts and refunds (refunded
purchases leave all revenue figures). Unmatched ids are listed back; nothing is guessed. The exact
columns of Roblox's exports may change, so map them to these three fields.

You can also enter Roblox-reported totals by hand (Settings → *Add a Roblox-reported number*), e.g.
Premium Payouts for a month. They are stored and shown as Roblox-reported, never mixed into tracked revenue.
