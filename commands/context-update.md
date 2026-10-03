---
description: Incrementally update .opencode/context/ after recent work via the context-manager agent.
agent: context-manager
subtask: true
---

Incremental context update.

Focus: $ARGUMENTS

If no focus was given, establish the recent work yourself (git status, git
diff, git log) and start from those changed files plus their immediate
architectural neighborhood.

Follow the incremental-update procedure in your system prompt: update a
context file only if this work introduced or revealed information that will
materially help future agents — a new boundary or module, a new or moved
canonical entry point, a changed workflow, a new convention, an architectural
decision, a new dependency between subsystems, a renamed or moved subsystem,
or a previously undocumented invariant.

Do not edit documentation just because source files changed. No
timestamp-only edits. If nothing material changed, make no edits and report
"no update needed".
