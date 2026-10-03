---
description: Audit .opencode/context/ for staleness, contradictions, excess size, duplication, and missing entry points.
agent: context-manager
subtask: true
---

Context review.

Everything outside `.opencode/context/` is read-only for this run. Do not
modify source code under any circumstances.

Audit the five context files for:

- stale information — verify claims against the actual code
- contradictions between context files, or between the map and the code
- excessive size — consolidate toward the per-file targets in your system
  prompt
- duplicated information — one canonical place per fact; link to the
  project's own docs rather than restating them
- missing canonical entry points for significant subsystems
- unsupported assumptions — anything stated as fact that you cannot verify,
  or that lacks a confidence marker

Fix what you find in `.opencode/context/` only, then report: findings, fixes,
and anything you could not verify.
