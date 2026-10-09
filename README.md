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
counter. Four is the cap: `opencode.jsonc` declares one hidden variant per base per slot,
and `pool-models.json` entries past the fourth are dropped with a warning.

| slot | model | provider | context | weight (ceiling) |
|---|---|---|---|---|
| 1 | `longcat-2.5-preview-free` | opencode-go | 1M | 3 |
| 2 | `space-bunny-free` | Zen | 1M | 2 |
| 3 | `big-pickle` | Zen | 200k | 1 |
| 4 | `longcat-2.5-preview-free` | Zen | 1M | 1 |

All four are free (verified 0/0 cost against models.dev). Weight is **a ceiling on how many
sessions one model runs at once**, not a share of the work, so the list is ordered by
preference and the bottom is reserve.

Slot 1 runs LongCat with **thinking disabled**, set in `opencode.jsonc` under
`provider.opencode-go.models`. Long thinking is its only demonstrated failure
mode: with thinking on it intermittently stalls after its tool calls complete,
emits a few dozen reasoning tokens and then returns nothing at all -- no text,
no error, exit 0, hanging until killed. Measured over 8 runs with thinking on:
2 stalls (25%), 112s-420s+. With thinking off, 13 runs, zero stalls, 35s-69s,
and reasoning tokens drop to 0. That avoids the trigger rather than fixing the
underlying fault, so a very long input could still surface it. Turning thinking
back on costs reasoning quality on hard problems.

Pooled base agents: **`explore-fast`**, **`implement-fast`**, **`context-manager`**.
The expensive escalation tiers (`explore-deep`, `implement-deep`, `expert`) stay
unpooled — they are deliberate, costly, and shouldn't compete for free-tier capacity.

### Routing

Load is counted **per model across all agent types**, so total pressure stays balanced. A
slot's `weight` in `pool-models.json` is a **soft ceiling on concurrent sessions, and that
same number is the priority**. The rule is two lines:

1. **the highest-weight slot still under its ceiling takes the spawn** — so slot 1 fills to
   its number before slot 2 sees any work at all
2. **once every slot is at its ceiling, the overflow goes to the least loaded slot**

```
1,1,1, 2,2, 3, 4, ...      weights 3,2,1,1
```

The main model gets its 3 sessions to itself, then space-bunny takes 2, then big-pickle and
Zen longcat take 1 each — no model is asked to multiplex past its ceiling while another sits
idle, which is what keeps per-session latency sane on a small free model.

The ceiling is soft on purpose: past the summed ceilings (7 here) the overflow equalises, so
a burst degrades to even spreading instead of piling onto slot 1 or blocking. Equal weights
give a plain round robin in list order, and `2,2,1,1` reproduces the old primary/overflow
cycle exactly — which is why the retired `tier` values still work as an alias.

`pool_status` shows each slot as `load=3/3 FULL` with `<- next` on the slot the next spawn
would take, so the priority order is readable without running anything.

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
AGENTS.md                 global instructions, auto-loaded into every session
bin/oc, bin/oc-notify     launcher (wraps opencode, notifies the local desktop) and a
                          single-notification helper
bin/oc-notify-receiver    the forced command a remote may run through the SSH tunnel;
                          installed to ~/.local/bin, never run from the repo
bin/oc-sync               deploy script; pushes oc, the tunnel key and the whole
                          opencode config. Hosts come from the gitignored .env
commands/context-*.md     /context-init, /context-update, /context-review
lib/pool.ts               shared pool state + slot decision (imported by both plugins)
lib/writer-rule.ts        startup check that the one-writer permission rule fires
plugins/agent-pool.ts     hooks: task routing, limit detection, hang reaper, pool_status
plugins/context-autoupdate.ts
                          keeps .opencode/context/ current; borrows a pool slot
plugins/notify.ts         desktop notification when a root session finishes;
                          subagents and the cartographer are suppressed
lib/notify.ts             the notification policy, pure and testable
pool-models.json          the pool's models and weights -- the file you edit
rules/browser.md          Playwright anti-loop rules, loaded via `instructions`
.opencode/prompts/        per-agent prompts
tests/                    9 test suites, no network needed
```

`AGENTS.md`, `commands/` and `rules/` are the context-map protocol, and `oc-sync` ships
all three to the remote hosts. They are also why `.opencode/context/` is *not* wired
into `instructions`: the protocol is small enough to inject everywhere, the map is not.

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
node tests/oc-test.mjs          # oc/oc-sync: default flags, tunnel auth, notification wiring
node tests/notify-test.mjs      # finish notifications: suppression policy, cooldown, wiring
```

`notify-test.mjs` needs node ≥ 22 for type stripping; hosts with an older system
node (one is on 12) cannot import the `.ts` modules directly. opencode itself is
unaffected — it loads plugins with its own bundled runtime.

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

`tests/models-snapshot.json` pins the free-cost proof. Regenerate it with
`node tests/refresh-models-snapshot.mjs` after changing `pool-models.json`: it reads
the current slots, records what each model cost and whether it can call tools, and
refuses to write anything if a model is not listed on models.dev. Skipping that step
after a model swap fails `pool-test.mjs` on the model it has never seen.

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
- `bin/oc-sync` distributes this setup to remote hosts, config included by default
  (`--scripts-only` opts out). It pushes `oc`, `oc-notify`, a dedicated SSH tunnel key,
  and `opencode.jsonc`, `pool-models.json`, `lib/`, `plugins/`, `.opencode/`, `AGENTS.md`,
  `commands/` and `rules/` — all but `.opencode/context/`, the derived map each host
  rebuilds for itself. The default used to be scripts-only, which silently left every host
  on the old `AGENTS.md` while the run reported success. `AGENTS.md`, `commands/` and `rules/` are load-bearing: they carry
  the context-map protocol that opencode injects into every session, and a host missing
  them runs agents that skip the map while believing the protocol is already loaded. The
  script lives in the repo; host names, addresses and usernames live in `.env`, which is
  gitignored. `.env.example` is the template and `~/bin/oc-sync` is a symlink to the repo
  copy.

## Inspecting it at runtime

`pool_status` reports live load per model and per agent type, each slot's load against its
weight ceiling, which slot the next spawn would take, cooldowns with remaining seconds, and
a per-process breakdown:

```
shared pool over 4 free models from pool-models.json; bases: explore-fast, implement-fast, context-manager
lowest load ratio wins, ties to the lighter slot: ratio = (claims + 2) / weight
priority is weight: the heaviest slot under its ceiling takes the next spawn
slot 1 w3  opencode-go/longcat-2.5-preview-free  load=2/3  [explore-fastx1 context-managerx1]
slot 2 w2  opencode/space-bunny-free  load=1/2  [implement-fastx1]
slot 3 w1  opencode/big-pickle  load=0/1  [idle]
slot 4 w1  opencode/longcat-2.5-preview-free  load=1/1 FULL  [explore-fastx1]

watchdog alive: last sweep 4s ago (every 30s).
```

`load=n/weight` is the ceiling and its state: `FULL` means the slot is at its number and is
only used again once every other slot is too. `<- next` is where the next spawn goes. `watchdog alive` is
the cheap way to confirm the reaper is actually running
without waiting for a hang — the reaper logs nothing when it finds nothing, so a silent
log is not evidence of a dead timer. Each process also logs one `reaper armed` line at
startup.