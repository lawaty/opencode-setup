---
description: Bootstrap the repository context map (.opencode/context/) via the context-manager agent.
agent: context-manager
subtask: true
---

Bootstrap the repository context map.

If `.opencode/context/` already exists, do NOT start over — verify and refresh
it in place (correct stale entries, fill gaps) using the review procedure in
your system prompt.

Otherwise follow the bootstrap procedure in your system prompt: progressive
exploration (README → existing docs → manifests → top-level structure → build
and framework config → entry points → selective source), then write the five
context files inside their size targets.

Remember: write conclusions, not inventories. Link to the project's existing
documentation instead of duplicating it.

Report what you created or updated, what you deliberately left out, and
anything that contradicts the code or existing docs.
