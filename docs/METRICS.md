# Metric definitions

All times are stored in UTC. "Day" means a calendar day in the **reporting time zone** (Settings).
Ranges are `[from, to)`; a range that includes today ends *now* and is labelled "so far". The
comparison period is the same length immediately before (today so far is compared with yesterday up
to the same time). A comparison is hidden when that period is before tracking began.

| Metric | Definition |
|---|---|
| **CCU** | Distinct players with an open session whose last heartbeat is within the session timeout (45 s). |
| **Peak CCU** | Highest CCU sample in the range (sampled every 15 s, kept per minute). |
| **Active servers** | Servers not shut down whose last heartbeat is within the timeout. |
| **Session** | One player on one server, join to leave. |
| **Visit** | One experience visit. Lobby → shift teleports continue the visit. *Visits* = visits that started in the range. |
| **Lifetime visits (tracked)** | Visits since tracking began. Roblox's own lifetime count is shown separately as *Roblox-reported*. |
| **Active players** | Distinct players with a session overlapping the range. |
| **DAU / WAU / MAU** | Distinct players active on that day / the 7 / 30 days ending that day. |
| **New players** | Players first seen in the range. On the first tracked day this includes players who played before tracking (flagged). |
| **Returning players** | Active players − new players. |
| **Average / median playtime** | Length of finished visits that started in the range, first join to last leave. Visits still going are excluded. |
| **Total playtime** | Sum of session time inside the range (sessions crossing the edge are clipped). |
| **Sessions per player** | Sessions started ÷ active players. |
| **Stickiness** | Average DAU over the last 30 days ÷ MAU. |
| **Churn** | Of players active in the previous period, the share with no activity in this one (whole-day ranges). |
| **Retention Dn** | Cohort = players first seen on day C. Dn = share of the cohort active on day C+n. A cell exists only once day C+n is over; a missing cell is "not yet", never 0. Summary values are cohort-size weighted and exclude the first tracked day. |
| **Gross revenue** | Robux of confirmed, non-refunded purchases. Developer products: `receipt.CurrencySpent`. Game passes: catalog price at verification (`catalog_list_price`). |
| **Estimated creator earnings** | Gross × creator share (Settings, default 70%). An estimate. Changing the share restates all past estimates. |
| **Verified earnings** | Only amounts confirmed by reconciliation with official Roblox records. Null until then. |
| **Paying users / conversion** | Distinct buyers; buyers ÷ active players. |
| **ARPDAU / ARPPU** | Gross ÷ sum of daily active players over the range; gross ÷ paying users. |
| **Prompt to purchase** | Confirmed purchases ÷ purchase prompts closed (`purchase_prompt` + `gamepass_prompt`). |
| **Run** | One player's attempt at one shift/night (`run_start` … `run_complete` / `run_fail` / `run_abandon`). |
| **Completion rate** | Completed ÷ finished runs. Runs in progress are excluded. |
| **Left before finishing** | Abandoned ÷ finished runs. |
| **Attempt** | n-th run of the same player at the same chapter and stage. |
| **Funnel** | Players reaching each step at or after the time they reached the previous step, within the range. |
| **Lost servers** | Servers that stopped heartbeating without a shutdown message. |

Charts read the aggregates, recomputed every 30 s; a bucket after the last recompute shows "no data",
never 0. Visit lengths are measured to the visit's real end even when it continues past the range.

Not measurable from game servers (shown as unavailable): traffic sources, impressions, official
demographics, Premium Payouts, private-server and UGC income, Roblox's final settlement.
