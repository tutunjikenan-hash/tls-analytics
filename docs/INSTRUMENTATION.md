# Gameplay instrumentation

`TLSAnalyticsGameHooks` reports The Last Shift's gameplay by **observing** state the game already
publishes, the same way `Telemetry.server.luau` does. It does not change gameplay. Only `first_customer`
chains `NightService.onResolve`, in the same way Telemetry and ShiftOrders already do.

## Events sent

| Event | When | Fields |
|---|---|---|
| `lobby_joined` | player arrives on a lobby server | |
| `gate_entered` | player's `Pod` attribute is set (stepped into a departure gate) | props.gate |
| `run_start` | Ch.1: `GameState.Phase` → `Shift`. Ch.2: `OutpostRun.Phase` → `Night`. Also for a player joining mid-run. | runId, chapter (`ch1`/`ch2`/`training`), stage (`night_N`), props.crew, props.difficulty |
| `first_customer` | first resolved customer for that player in the run | runId |
| `horror_event` | `GameState.ActiveEvent` set, or `IntroScare` | props.kind = event name |
| `objective_complete` | `GameState.StoryObjectiveId` moves on | props.objective |
| `final_hour` | `GameState.FinalHourStage` = 1 | runId |
| `downed` | player attribute `Downed` = true | props.cause = the event active at that moment (or `unknown`) |
| `run_complete` | Ch.1 `Phase` → `Ended` with `LastOutcome` = `Survived`; Ch.2 `Phase` → `Results` | |
| `run_fail` | Ch.1 ended otherwise (props.reason = FailureCause, props.mistakes); Ch.2 run closed before Results | |
| `run_abandon` | player leaves during a run (props.reason = `left`); the backend also abandons runs whose player is gone 10 min | |
| `retry` | PlayAgain / Retry on the results screen | props.kind |
| counters `device_touch` / `device_desktop` / `device_console` | client's device report through the existing Telemetry remote (client-reported, indicative) | |

Stage shown on Live players: `lobby`, `gate`, `night_N`, `results`, `ch2_prep`, `ch2_dusk`,
`ch2_night_N`, `ch2_results`.

The default funnel (Settings) is `lobby_joined → gate_entered → run_start → first_customer →
final_hour → run_complete`.

Not instrumented, because the game doesn't publish them reliably: where exactly a player was when
downed (`area`), and which monster downed them beyond the active event. Add them with `track` from the
code that knows (below) rather than guessing.

## Adding events: `TLSAnalytics.track`

From any **server** script:

```lua
local TLSAnalytics = require(game:GetService("ServerScriptService").TLSAnalytics)

TLSAnalytics.track(player, "item_used", {
	runId = currentRunId,      -- optional: ties the event to a run
	chapter = "ch1",           -- optional
	stage = "night_3",         -- optional
	area = "back_room",        -- optional, shows on "Where players die" for downed/death
	value = 12.5,              -- optional number
	props = { item = "flashlight", charges = 2 }, -- up to 20 string/number/boolean values
})

TLSAnalytics.setStage(player, "night_3")  -- what Live players shows for this player
TLSAnalytics.count("lantern_lit")          -- a per-minute counter, no player
```

Rules: names are `snake_case`, 2–48 characters. Calls never throw and never yield. Events with a
`runId` and the names `run_start`, `run_complete`, `run_fail`, `run_abandon` feed the run tables
(completion, attempts, time to complete); every other name appears under *All gameplay events* and
can be used in the funnel. Never put personal data in props.

## Wire format (for reference)

```json
POST /api/ingest/v1/events
Authorization: Bearer tls_...
X-TLS-Request-Id: 3f0c...uuid
{ "v": 1, "env": "production", "serverId": "<JobId>", "placeId": 134111235673543, "placeVersion": 812,
  "serverKind": "public", "sentAt": 1761500000000,
  "events": [ { "id": "<uuid>", "type": "game", "ts": 1761499999000, "uid": 123, "sid": "<session uuid>",
                "d": { "name": "run_start", "runId": "a1b2", "chapter": "ch1", "stage": "night_1" } } ] }
```

Types: `server_start`, `server_heartbeat` (`d.players[{sid,uid,stage}]`, fps, memMb, uptimeSec),
`server_stop`, `session_start` (`d.teleportIn`, `d.referred`, `d.country`), `session_end`
(`d.reason`, `d.durationSec`), `purchase`, `game`, `counter`. See `src/server/ingest/schema.ts`.
