# Operations runbook

Design and rationale live in [README.md](README.md). This file is the day-to-day
reference: what runs where, what needs a restart, how to check the pool is healthy,
and how the pieces are distributed.

## Components

| Path | Role |
|---|---|
| `opencode.jsonc` | 19 agents (3 pooled bases + 12 hidden variants + 4 unpooled), permissions, provider whitelists |
| `lib/pool.ts` | shared state and the slot decision; imported by both plugins, exports no plugin |
| `plugins/agent-pool.ts` | task routing, limit detection, 30s hang reaper, `pool_status` |
| `plugins/context-autoupdate.ts` | keeps `.opencode/context/` current; borrows a pool slot |
| `.opencode/prompts/` | 6 prompts shared by 19 agents |
| `tests/` | 6 offline suites, no network, no running server |
| `~/bin/oc-sync` | distributes this setup to the two remote hosts (outside the repo, host-specific) |
| `~/.local/share/opencode/agent-pool/` | live cross-process claims + cooldowns |
| `~/.local/share/opencode/auth.json` | credentials — deliberately **outside** this repo |
| `~/.opencode/context/` | the context map for `/home/yourname` (see below) |

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

## Restarts

**Plugins are not hot-reloaded.** Any change to `opencode.jsonc`, `lib/`, or `plugins/`
requires restarting every opencode process. Servers are foreground processes with no
systemd unit or tmux session, so each is restarted from its own terminal.

This bites in a specific way: a config change is invisible until restart, so a fix can
look applied and still not be running. Always check `ps -eo pid,lstart,comm | grep opencode`
against the file mtime before concluding a change is live.

## Deploying to the other hosts

```bash
./bin/oc-sync --with-config           # both remote hosts
./bin/oc-sync --with-config --dry-run # preview
./bin/oc-sync --host <alias>          # one host (see aliases in ~/.oc-hosts)
```

Pushes `opencode.jsonc`, `lib/`, `plugins/`, `.opencode/` — with a remote backup first.
Two ordering and scope rules that are easy to get wrong:

- **`lib/` must land before `plugins/`.** Both plugins import `../lib/pool.ts`; a
  plugins-first sync leaves them unable to resolve on next restart.
- **`node_modules`, `package-lock.json`, and `tests/` are not synced.** Each host keeps
  its own install and SDK version. Consequence: the `1.16.2` pin in `package.json` is
  **not** enforced anywhere — it is documentation, not a constraint. Verify the SDK
  version on a host before assuming parity.

Remotes are plain rsync copies with no `.git`, so they carry no history. Local is the
only place edits are made; a remote-side change is untracked and will be overwritten by
the next sync.

## The context map

`context-autoupdate` maintains a five-file map per project at `.opencode/context/`.
For `/home/yourname` that is `~/.opencode/context/`, which is **not** inside this repo
and is **not** synced to the other hosts — see [Version control](#version-control).

Trigger: a root session goes idle after editing files outside the map. It borrows a pool
slot, spawns `context-manager`, and applies changes. `context-manager` is the single
writer; other agents read the map but never write it.

Two operational rules:

- **A `finished` log line is not evidence the map changed.** A run blocked from writing
  resolves identically to a successful one. The plugin now reports `changed: N`, counts
  files that actually moved on disk, and warns at `changed: 0`.
- **If the map goes stale, check the one-writer permission rule first.** opencode matches
  permission patterns against the *resolved absolute* path, so a rule written relative to
  the project root silently never fires. It must be `*/.opencode/context/**`. The plugin
  now verifies this at startup and logs an error naming the offending rule;
  `tests/permission-test.mjs` pins it, including against the real `opencode.jsonc`.

Force a run with `/context-update` rather than waiting for the idle trigger.

## Version control

This repo (`~/.config/opencode`) is a git repository, public at
`github.com/lawaty/opencode-setup`, tracking `origin/master`.

Not covered by git:

- **The context map** (`~/.opencode/context/`) — unversioned and unsynced. It is the only
  part of the system with no backup.
- `~/bin/oc-sync` and `~/.oc-hosts` — host-specific, outside the repo deliberately.
- The remote hosts — rsync copies, no history.

Before publishing anything here, note that the repo is **public**: treat every tracked
file as public. Keep host names, IPs, and credentials out of it, and keep `auth.json`
in `~/.local/share/opencode/` where it is.

## Troubleshooting

**A pooled spawn went to an unexpected model.** Read the `routed` log line for the
`slot=` and `tier=` fields, then check for a `limit.<provider>__<model>.json` file — a
stale one with a future `until` will keep diverting work.

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