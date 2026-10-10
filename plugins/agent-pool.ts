// Local development shim -- NOT the source of truth.
//
// opencode auto-discovers every file in plugins/ and calls every export of it as
// a plugin, so this file exists only to keep the working-tree setup loading
// src/plugins/agent-pool.ts. The published package has exactly ONE plugin,
// src/index.ts; this shim is not shipped (plugins/ is not in package.json
// "files") and is not referenced by the published entry point.
//
// Renaming the export here is the whole point: a plugin file must export exactly
// one plugin, and it does.

export { agentPoolHooks as AgentPool } from "../src/plugins/agent-pool.ts"