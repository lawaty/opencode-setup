// Local development shim -- NOT the source of truth. See ./agent-pool.ts.
// One export, because a plugin file must export exactly one plugin.

export { contextAutoUpdateHooks as ContextAutoUpdate } from "../src/plugins/context-autoupdate.ts"