# opencode setup — shared free-model agent pool

My personal [opencode](https://opencode.ai) configuration, built around one idea: a small
set of **free** models shared by every fast agent type, load-balanced across processes
and aware of rate limits.

Everything that does routine work — exploration, implementation, and repository
cartography — acquires a model from the same pool instead of each agent owning one.
A saturated `explore-fast` therefore cannot hide behind its own dedicated model while
`big-pickle` burns out.

## The pool

Four slots, each a **model** (not an agent). Slot *N* is the same model for every base
agent, so `explore-fast-2` and `context-manager-2` are the same model sharing one load
counter.

| slot | model | provider | context | tier |
|---|---|---|---|---|
| 1 | `big-pickle` | Zen | 200k | primary |
| 2 | `space-bunny-free` | opencode-go | 1M | primary |
| 3 | `nemotron-3-ultra-free` | Zen | 1M | overflow |
| 4 | `longcat-2.5-preview-free` | opencode-go | 1M | overflow |

All four are free (verified 0/0 cost against models.dev). Two providers, so a
provider-wide limit can disable at most half the pool.

Pooled base agents: **`explore-fast`**, **`implement-fast`**, **`context-manager`**.
The expensive escalation tiers (`explore-deep`, `implement-deep`, `expert`) stay
unpooled — they are deliberate, costly, and shouldn't compete for free-tier capacity.

### Routing

Load is counted **per model across all agent types**, so total pressure stays balanced:

- the two primary slots are kept equal and hold a `TIER_MARGIN = 2` lead over the
  least-loaded overflow slot
- from the third spawn onward the sequence is exactly the cycle `1,2,3,4`
- 6 concurrent tasks → `2/2/1/1`; 12 → `4/4/2/2`

Two agents reach the pool differently, and both share one state:

- `explore-fast` / `implement-fast` arrive as `task` tool calls and are rewritten in
  `tool.execute.before`
- `context-manager` is spawned by `context-autoupdate` through the session API, so it
  borrows a slot from the shared module directly

## Rate-limit handling

A usage-limited request **hangs** rather than failing, so the caller never regains
control and the claim is never released. There is no upstream quota API — the server
exposes 162 endpoints, none for usage, and `api.opencode.ai` answers `Not Found` on
every usage path — so a limit cannot be predicted before the first request. Instead:

1. **Catalog gate** — `/api/model` exposes per-model `status`; a model opencode has
   retired is never chosen.
2. **Cooldowns** — assistant errors carrying an `APIError` name the provider and model
   directly, and opencode reports free-tier exhaustion itself as a `retry` status with
   `action.reason: "free_tier_limit"`, the provider, and a reset timestamp. Both write
   a cooldown file that **every process reads before routing**, so a model that just
   rate-limited one project is skipped by all of them. Duration is the provider's stated
   reset when given, otherwise exponential backoff (60s → 120s → …, capped at 15 min).
3. **Hang reaper** — a hang is silent: no error event, no log line, no message delta. A
   claim older than `STUCK_MIN_AGE_MS` whose target session has been silent for
   `STUCK_IDLE_MS` is presumed wedged; that session is aborted, returning control to the
   caller, freeing the slot, and cooling the model. Runs on a 30s interval **and once at
   startup**, so an idle session never sits on a dead task.

If every slot is cooling, routing deliberately falls back to trying anyway rather than
refusing work — a total provider outage degrades to escalating cooldowns, not a halt.

## Cross-process state

Several opencode servers run at once, so each publishes **only its own claims** to
`~/.local/share/opencode/agent-pool/claims.<pid>.json`. No locking, no lost updates;
routing reads every sibling file. Cooldowns are one file per model for the same reason.

```
~/.local/share/opencode/agent-pool/
├── claims.<pid>.json                      # in-flight work, one file per process
└── limit.<provider>__<model>.json         # cooldowns, one file per model
```

## Layout

```
opencode.jsonc            agents, permissions, provider whitelists (no pool models)
bin/oc, bin/oc-sync       launcher and deploy script; hosts come from the gitignored .env
pool-models.json          the pool's models and tiers -- the file you edit
lib/pool.ts               shared pool state + slot decision (imported by both plugins)
lib/writer-rule.ts        startup check that the one-writer permission rule fires
plugins/agent-pool.ts     hooks: task routing, limit detection, hang reaper, pool_status
plugins/context-autoupdate.ts
                          keeps .opencode/context/ current; borrows a pool slot
.opencode/prompts/        per-agent prompts
tests/                    6 test suites, no network needed
```

`lib/` lives outside `plugins/` on purpose: opencode loads **every export** of every file
in `plugins/` as a plugin and uses the return value as a hooks object, so a stray export
there is not a helper, it is a broken plugin. A non-plugin helper exported from
`context-autoupdate.ts` once returned `undefined`, poisoned the shared hook registry, and
took down every hook dispatch — opencode would not start. Both modules here export no
plugin, which is also why `verifyWriterRule` was moved out of the plugin file rather than
left beside it.

## Tests

No network, no running server — each suite drives the hooks directly and uses a temp
directory as the shared claim dir.

```bash
node tests/pool-test.mjs        # routing, cross-process sharing, config invariants
node tests/pool-limits-test.mjs # cooldowns, backoff, stated resets, degraded mode
node tests/pool-hang-test.mjs   # hang detection, abort, never killing live work
node tests/pool-shared-test.mjs # slots shared across base agent types
node tests/pool-timer-test.mjs  # reaper on a timer with no new spawns
node tests/pool-models-test.mjs # pool-models.json drives agents, whitelists, fallbacks
node tests/permission-test.mjs  # the one-writer rule actually matches the map path
```

`pool-timer-test.mjs` and the `AI_APICallError` cases in `pool-limits-test.mjs` are
regressions for two bugs that reached production: the reaper originally ran only on the
next task spawn (a hung task survived 18 minutes), and limit detection only matched an
error shape opencode never actually emits.

`permission-test.mjs` covers a third: the context map could not be written at all.
`prompt()` resolves either way, so a fully blocked run logged `finished files=4`
while changing nothing, and the map sat stale for days. The cause was the one-writer
permission rule: opencode evaluates file permissions against the path **relative to the
project root**, and the rule was written for the absolute path — so after `6f6af0a`
"corrected" it that way, the map was still unwritable, undetected, because the
startup check was matching the absolute path too. Both spellings are now allowed and
the check follows the form that applies to the running project. `context-autoupdate.ts`
reports how many map files actually changed on disk, rather than how many it offered
the cartographer.

`tests/models-snapshot.json` pins the free-cost proof; refresh it with
`curl -sS https://models.dev/api.json`.

`pool-models-test.mjs` covers the fourth regression class: the pool's models used to be
duplicated in `lib/pool.ts` *and* in twelve agent definitions, so changing one meant
three edits that could silently disagree — a variant agent could keep a model the router
no longer used, and an unwhitelisted model resolves to no model at all. One file now
owns the list, the config hook derives everything else from it, and the tests fail if a
`model` creeps back into a variant.

## Operational notes

- **Day-to-day reference: [OPERATIONS.md](OPERATIONS.md)** — health checks, restart
  rules, deploying to the other hosts, the context map, and what is not under version control.
- **Plugins are not hot-reloaded.** Every change here needs a restart of each running
  opencode process. There is no systemd unit or tmux session — they are foreground
  processes, so restart each in its own terminal.
- `auth.json` lives in `~/.local/share/opencode/`, **not** in this repo.
- `@opencode-ai/plugin` is pinned to the opencode binary's own version (**1.18.34**) so the
  SDK and the runtime agree; a mismatch is silent, since only `tool()` is called at runtime
  and nothing type-checks in production. Check `package.json` on each machine before
  assuming parity.
- `bin/oc-sync` distributes this setup to remote hosts (`--with-config` also pushes
  `lib/`, which the plugins import). The script lives in the repo; host names, addresses
  and usernames live in `.env`, which is gitignored. `.env.example` is the template and
  `~/bin/oc-sync` is a symlink to the repo copy.

## Inspecting it at runtime

`pool_status` reports live load per model and per agent type, the tier split, cooldowns
with remaining seconds, and a per-process breakdown:

```
slot 1 primary  opencode/big-pickle  load=2  [explore-fastx1 context-managerx1]
slot 2 primary  opencode-go/space-bunny-free  load=1  [implement-fastx1]
slot 3 overflow opencode/nemotron-3-ultra-free  load=0  [idle]

watchdog alive: last sweep 4s ago (every 30s).
```

The `watchdog alive` line is the cheap way to confirm the reaper is actually running
without waiting for a hang — the reaper logs nothing when it finds nothing, so a silent
log is not evidence of a dead timer. Each process also logs one `reaper armed` line at
startup.