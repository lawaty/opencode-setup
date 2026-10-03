# Global rules

## Repository context system (mandatory, every agent, every project)

The repository context map lives in `.opencode/context/` and has five files:
`architecture.md` (cross-subsystem tasks), `contexts.md` (subsystem work),
`conventions.md` (before writing or modifying code), `workflows.md` (tracing
runtime behavior), `decisions.md` (architectural constraints).

### Before any broad exploration

1. **Check the map first.** Run `ls .opencode/context` with the `list` tool or
   `bash` — NEVER the `glob` tool: it does not match hidden directories and will
   falsely report "no files". If you delegate all investigation (e.g. Plan Mode),
   make this the first instruction to your exploration subagent.
2. **Map present → read one file.** Read only the file relevant to the current
   task, then start from the canonical entry points it lists. Explore beyond them
   only when the task requires it. Narrow, don't sweep.
3. **Map missing or empty → bootstrap before proceeding.** Spawn the
   `context-manager` subagent (`subagent_type: "context-manager"`) to initialize
   the map for this repository. Never write the map yourself. If you cannot spawn
   it, proceed with minimum sufficient exploration and state prominently in your
   final report that the map is missing and must be bootstrapped.

### After a session that changed files

`plugins/context-autoupdate.ts` automatically runs `context-manager`
(bootstrap or incremental update) whenever a root session that edited files goes
idle. Do NOT run a redundant update on top of it. Spawn `context-manager`
yourself (`/context-update`) ONLY with positive evidence the automatic run did
not happen: you know the map is stale, or the plugin is disabled or failed.

### Hard rules

- **One writer.** `context-manager` is the ONLY writer of `.opencode/context/`.
  Every other agent reports needed map changes in its final message; it never
  edits the map.
- **Source code wins.** If the map conflicts with the code, trust the code, report
  the discrepancy, and never edit source to match the map.
- **Priority order.** Files the user explicitly named → the current task's context
  → the map → targeted exploration. The map supplements, never overrides.

### Reporting

When your work reveals something that belongs on the map — a new boundary,
canonical entry point, workflow, convention, or architectural decision — say so
in your final report so `context-manager` can capture it. Cite the context files
that shaped your work; never paste their contents.

User commands: `/context-init` (bootstrap), `/context-update` (incremental
update), `/context-review` (audit).