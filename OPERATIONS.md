# Operations runbook

Design and rationale live in [README.md](README.md). This file is the day-to-day
reference: what runs where, what needs a restart, how to check the pool is healthy,
and how the pieces are distributed.

## Components

| Path | Role |
|---|---|
| `pool-models.json` | the pool's models and weights — the only file to edit to swap a model or change how many sessions it runs |
| `opencode.jsonc` | 19 agents (3 pooled bases + 12 hidden variants + 4 unpooled), permissions, provider whitelists. The 12 variants declare **no model**: it is injected from `pool-models.json` |
| `lib/pool.ts` | shared state and the slot decision; imported by both plugins, exports no plugin |
| `lib/writer-rule.ts` | startup check that the one-writer permission rule actually fires; imported by `context-autoupdate.ts` |
| `plugins/agent-pool.ts` | task routing, limit detection, 30s hang reaper, `pool_status` |
| `plugins/context-autoupdate.ts` | keeps `.opencode/context/` current; borrows a pool slot |
| `.opencode/prompts/` | 6 prompts shared by 19 agents |
| `tests/` | 7 offline suites, no network, no running server |

## Health checks

```bash
opencode run "pool_status"          # live load, cooldowns, watchdog liveness
tail -f ~/.local/share/opencode/log/opencode.log | grep -E "routed|cooling|hung|reaper"
```

`pool_status` is the authoritative check. Three things to look for:

- `watchdog alive: last sweep Ns ago (every 30s)` — if this exceeds ~60s the reaper
  is not running and hung tasks will hold their slot. It is the only positive signal;
  the reaper logs nothing when it finds nothing.
- `COOLING` on a slot — expected during rate limiting, and the pool routes around it.
- `hung … auto-aborted` — the reaper recovering a wedged task. Fine occasionally;
  repeatedly means a model or provider is unhealthy.

Log lines worth knowing: `routed <base> -> <variant>` on every pooled spawn,
`borrowed pool slot N … for auto update` when the cartographer runs,
`reaper armed` once per process at startup.

## Changing the pool models

Edit `pool-models.json` — one entry per slot, array position is the slot number:

```json
{ "slots": [
  { "model": "opencode-go/longcat-2.5-preview-free", "weight": 3 },
  { "model": "opencode/big-pickle", "weight": 2 },
  { "model": "opencode/space-bunny-free", "weight": 1 },
  { "model": "opencode/longcat-2.5-preview-free", "weight": 1 }
] }
```

At most **4 slots**: `opencode.jsonc` declares one hidden variant per base per slot, so a
fifth entry would route spawns at an agent that does not exist. Entries past the fourth are
dropped with a warning, not silently ignored.

`weight` is a **soft ceiling on how many concurrent sessions one slot runs**, and that same
number is its priority. Two rules, in order:

1. the **highest-weight slot still under its ceiling** takes the spawn, so the main model
   gets its 3 sessions to itself before slot 2 sees any work
2. once **every** slot is at its ceiling, the overflow goes to the least loaded slot, so a
   burst past the summed ceilings equalises instead of piling up or blocking

So `3,2,1,1` produces `1,1,1,2,2,3,4,…` — ordered preference, with the bottom of the list as
reserve. Weights are dynamic and deliberately unequal, so this is never a share calculation:
a slot either has room under its ceiling or it does not. Equal weights give a round robin in
list order, and `2,2,1,1` reproduces the old primary/overflow cycle exactly.

Raise a weight to let a model run more sessions at once, lower it to make it more of a
reserve. No weight means `1`; anything that is not a number in `(0, 100]` warns and means `1`.
The old `tier` key is still read as a deprecated alias — `primary` is weight 2, `overflow` is
weight 1 — with a warning, so a host that has not picked up this file keeps two slots' worth
of headroom.

Do **not** also edit the variant agents in `opencode.jsonc` — they carry no `model` on
purpose. The plugin's config hook writes `<base>-<slot>` for `explore-fast`,
`implement-fast` and `context-manager` from this file, and adds any missing provider
whitelist entry. A `model` that reappears on a variant is stale: the plugin logs
`still hard-codes … pool-models.json wins` on every start.

Keep the provider configured in `opencode.jsonc` and the models free and tool-call
capable — check with `curl -sS https://models.dev/api.json` or `opencode models
<provider>`. Then restart every opencode process and confirm what is actually live:

```bash
opencode debug agent explore-fast-1   # model it resolved
opencode run "pool_status"            # slots, load/weight, ceilings, cooldowns
```

Failure modes are logged, never silent: a bad entry (no `provider/model-id`, a repeated
model, a fifth slot) is dropped with a warning and the other slots still route; a bad
`weight` is only a preference, so it warns and keeps the slot at weight 1; a file that
yields nothing usable falls back to the built-in defaults. All of them appear in the log as
`pool-models.json …`, so check
`tail -f ~/.local/share/opencode/log/opencode.log | grep pool-models` when a spawn
resolves to the wrong model or lands on an unexpected slot. If the plugin is disabled
(`opencode --pure`) the variants have no model at all and inherit the session's — check the
plugin is loading before debugging a wrong model.

## Restarts

**Plugins are not hot-reloaded.** Any change to `pool-models.json`, `opencode.jsonc`,
`lib/`, or `plugins/` requires restarting every opencode process. Servers are foreground processes with no
systemd unit or tmux session, so each is restarted from its own terminal.

This bites in a specific way: a config change is invisible until restart, so a fix can
look applied and still not be running. Swapping a pool model is where it matters most:
the file says one thing, a long-running server keeps routing to the old one. Always check `ps -eo pid,lstart,comm | grep opencode`
against the file mtime before concluding a change is live.

## Why opencode.jsonc is ~730 lines

Audited, and most of it is structural rather than redundant:

- **12 of the 19 agents are pool variants** (`explore-fast-1..4`, `implement-fast-1..4`,
  `context-manager-1..4`). Each must be a distinct agent because each must resolve a
  distinct model, and opencode has no agent inheritance, so each repeats its base's
  prompt and permission block. Generating them from the plugin does not work: an agent
  created in the `config` hook is not registered by opencode (`opencode debug agent` for
  a hook-created name returns "not found"), which is why they are declared here.
- **Task rules use globs** (`explore-fast*`), because opencode compiles a permission
  pattern to an anchored regex with `*` → `.*` and the longest match wins. Listing all
  four variants per base meant adding a line to two agents for every new slot.
- **The models are not here at all** — `pool-models.json` owns them and the plugin
  injects them.
- Playwright stays: the explore and implement agents may drive a browser even though
  no prompt says so. The per-agent grant uses the deprecated `tools` field on purpose.
  The schema points at `permission`, but `permission` has no entry for MCP tools, and
  `opencode debug agent` never lists MCP tools at all -- so neither it nor the schema can
  confirm a working grant. Verified end to end instead: `explore-fast-3` reports all 26
  `playwright_browser_*` tools, and the top-level `tools.playwright_*: false` keeps them
  away from every other agent.
- `explore`, `general` and `implement` are disabled. These are opencode's built-in
  generic subagents; they would always be spawnable, cost a full-price model, and bypass
  `explore-fast*` / `implement-fast*` entirely. Only `basic`, `expert`, the pool bases and
  their variants, and the deep agents remain. `pool-test.mjs` pins this, so an opencode
  upgrade that reintroduces a built-in fails there rather than quietly doubling the
  delegation paths.
| `bin/oc`, `bin/oc-sync` | the `oc` launcher and the deploy script, both in the repo; `~/bin/oc` and `~/bin/oc-sync` are symlinks to them |
| `.env` / `.env.example` | host list and deploy overrides — `.env` is gitignored, `.env.example` documents every variable |
| `~/.local/share/opencode/agent-pool/` | live cross-process claims + cooldowns |
| `~/.local/share/opencode/auth.json` | credentials — deliberately **outside** this repo |
| `.opencode/context/` | this project's context map — derived, not in git (see below) |

## Deploying to the other hosts

```bash
bin/oc-sync --with-config           # every host in $OC_HOSTS
bin/oc-sync --with-config --dry-run # preview
bin/oc-sync --host <alias>          # one host
```

Pushes `opencode.jsonc`, `pool-models.json`, `lib/`, `plugins/`, `.opencode/`,
`AGENTS.md`, `commands/`, `rules/` — with a remote backup first.

**`AGENTS.md`, `commands/` and `rules/` are not optional extras.** `AGENTS.md` is the
global instruction file opencode auto-loads into every session, and `commands/` +
`rules/` are what it points at. A host missing them runs agents that were never told
`.opencode/context/` exists, and they will report skipping the map while claiming the
protocol was loaded. That is exactly what happened: one host carried a 368-byte stub
`AGENTS.md` claiming the protocol arrived via `instructions` in `opencode.jsonc` — a key
that was never added — while another had no `AGENTS.md` at all. Both were in git and in
`OPERATIONS.md`, so the bug was invisible locally. If a host's agents ever deny reading
the map, diff the remote's `AGENTS.md` byte count against the local one before touching
anything else.

A failed transfer is a failure, not a detail: every rsync's exit status is checked
before its output is filtered, and the host is listed under `failed` with the
directory left behind so you know what state it is in. `--dry-run` writes nothing at
all, locally or on the remote — it reports the `~/bin` PATH line, `OC_LOCAL_USER` and
`authorized_keys` entries it *would* add. `.opencode/context/` is excluded from the
transfer: it is the derived map of whatever projects a host works on, so each host
regenerates its own.

**Host details live in `.env`, not in the repo.** The repo is public, so `bin/oc-sync`
carries no names, addresses or usernames: it reads `OC_HOSTS` (whitespace, comma or
newline separated) and optional overrides from `.env`, which `.gitignore` keeps out of
git. `.env.example` is the template. With no `.env`, the script falls back to the legacy
`~/.oc-hosts`. `.env` is sourced before the script's defaults, so it wins over exported
variables. `~/bin/oc` and `~/bin/oc-sync` are symlinks into the repo, so both spellings
work.
Two ordering and scope rules that are easy to get wrong:

- **`lib/` must land before `plugins/`.** Both plugins import from `../lib/`; a
  plugins-first sync leaves them unable to resolve on next restart. `lib/` must also keep
  exporting **no plugin**: opencode calls every export of every file in `plugins/` as a
  plugin and uses the return value as a hooks object, so a helper left there is a broken
  plugin. One did exactly that (`verifyWriterRule`) and opencode stopped starting.
- **`node_modules`, `package-lock.json`, and `tests/` are not synced.** Each host keeps
  its own install and SDK version. Consequence: the `1.18.34` pin in `package.json` is
  **not** enforced anywhere — it is documentation, not a constraint. Verify the SDK
  version on a host before assuming parity, and keep it equal to that host's opencode
  binary version.

Remotes are plain rsync copies with no `.git`, so they carry no history. Local is the
only place edits are made; a remote-side change is untracked and will be overwritten by
the next sync.

## The context map

`context-autoupdate` maintains a five-file map per project at `.opencode/context/`,
resolved from the session's own directory (`path.resolve(directory)`). So
`/home/yourname` gets `~/.opencode/context/`, and a different project gets its own.

It is deliberately **not** in git and **not** synced to the other hosts. The map is a
derived artifact — an index regenerated from the source by `context-manager`, not source
itself — and it is scoped to one machine's filesystem. Syncing it would push a
description of this host's projects onto hosts that have different ones, and committing it
would churn on every session that touches a file. Git holds the rules that generate it
(`AGENTS.md`, `commands/context-*.md`, `rules/browser.md`, the plugin, the tests) and all
of those now ship to the remotes; the map itself is rebuilt on demand by the next
cartographer run.

There is no `rules/context-protocol.md` anymore. It duplicated the global `AGENTS.md`
while nothing loaded it, so it was deleted; `rules/browser.md` survives because its
Playwright anti-loop rules exist nowhere else and are now loaded through the
`instructions` key in `opencode.jsonc`. The context map is deliberately **not** in
`instructions` — that would inject all five files into every session and every pooled
subagent, defeating the read-one-file rule `AGENTS.md` states.

Trigger: a root session goes idle after editing files outside the map. It borrows a pool
slot, spawns `context-manager`, and applies changes. `context-manager` is the single
writer; other agents read the map but never write it.

Two operational rules:

- **A `finished` log line is not evidence the map changed.** A run blocked from writing
  resolves identically to a successful one. The plugin now reports `changed: N`, counts
  files that actually moved on disk, and warns at `changed: 0`.
- **If the map goes stale, check the one-writer permission rule first.** opencode evaluates
  file permissions against the path **relative to the project root**, not the absolute path
  the tool was handed — a write of `/repo/.opencode/context/architecture.md` is evaluated as
  `.opencode/context/architecture.md`. Patterns are anchored, so neither spelling covers
  every project on its own: `.opencode/context/**` fires for a normally-rooted project but
  not when the project root is `/`, and `*/.opencode/context/**` fires *only* when it is.
  **Both are required.** A relative-only rule was silently broken first; "fixing" it to the
  absolute form (`6f6af0a`) silently broke it again, because the detector was checking the
  absolute path too. `lib/writer-rule.ts` now checks the form that applies to the running
  project's root and logs an error naming the offending rule; `tests/permission-test.mjs`
  pins both directions, including against the real `opencode.jsonc`.

Force a run with `/context-update` rather than waiting for the idle trigger.

## Version control

This repo (`~/.config/opencode`) is a git repository, public at
`github.com/lawaty/opencode-setup`, tracking `origin/master`.

Not covered by git:

- **The context map** (`~/.opencode/context/`) — intentionally outside git and not synced.
  Derived, per-project, and rebuilt on demand; see [The context map](#the-context-map).
- `~/bin/oc-hosts` and `.env` — host-specific, deliberately outside version control.
  `bin/oc-sync` reads the host list from `.env`; `~/.oc-hosts` remains only as a
  fallback for when `.env` is absent.
- The remote hosts — rsync copies, no history.

Before publishing anything here, note that the repo is **public**: treat every tracked
file as public. Keep host names, IPs, and credentials out of it, and keep `auth.json`
in `~/.local/share/opencode/` where it is.

## Troubleshooting

**A pooled spawn went to an unexpected model.** Read the `routed` log line for the `slot=`,
`weight=` and `ceiling=` fields, then check for a `limit.<provider>__<model>.json` file — a
stale one with a future `until` will keep diverting work. If the model is right but the slot
is not the one you expected, that is the weight: routing takes the heaviest slot still under
its ceiling, not the emptiest one.

**Everything routes to one provider.** Check for `limit.*.json` files cooling the other.
A provider-wide `free_tier_limit` cools every slot on that provider at once, which is
intentional: the alternative is a hang.

**The map is stale / the cartographer reports success but nothing changed.** Look for
`context map is not writable` in the log first, then confirm the map files' mtimes.

**Suspected hang.** Run `pool_status`. If a claim is older than 5m with 3m of silence it
is aborted automatically within ~30s; if the watchdog line shows no recent sweep, restart
the process — the timer is not running.

**A plugin change appears to have no effect.** It is almost certainly not reloaded. Check
process start time against file mtime.