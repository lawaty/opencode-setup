// Regression tests for the silent-stale-map failure.
//
// context-autoupdate reported "auto update finished files=4" on 2026-10-04 while
// writing nothing. The one-writer permission rule was ".opencode/context/**", but
// opencode compiles permission patterns to anchored regexes (* -> .*) and matches
// them against the RESOLVED ABSOLUTE path, so that rule could never fire. Every
// write was denied, and prompt() still resolved, so a completely blocked run was
// indistinguishable from a successful one and the map sat stale for days.
//
// These tests pin the detector that turns that class of bug into a startup error.
//
// Run: node ~/.config/opencode/tests/permission-test.mjs
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyWriterRule } from "../plugins/context-autoupdate.ts"

const MAP = "/home/yourname/.opencode/context"
const dir = mkdtempSync(join(tmpdir(), "pool-perm-"))
const config = (rules) => {
  const file = join(dir, "opencode.jsonc")
  writeFileSync(
    file,
    `{"agent":{"context-manager-1":{"permission":{"edit":{"*":"deny",${rules}},"write":{"*":"deny",${rules}}}}}}`,
  )
  return file
}

let checks = 0
const ok = (name) => {
  checks++
  console.log(`  ok  ${name}`)
}

try {
  // The fix: a leading */ is required because the matched path is absolute.
  assert.equal(verifyWriterRule(config('"*/.opencode/context/**":"allow"'), MAP), undefined)
  ok('leading "*/" rule matches the absolute map path')

  // The original bug: relative-only rule matches nothing.
  const broken = verifyWriterRule(config('".opencode/context/**":"allow"'), MAP)
  assert.ok(broken, "relative-only rule must be reported as broken")
  ok('relative-only ".opencode/context/**" is reported as broken')
  assert.match(broken, /not writable/)
  assert.match(broken, /none of the allow rules/)
  ok("broken message states the map is not writable")
  assert.match(broken, /\.opencode\/context\/\*\*/, "message should name the offending rule")
  assert.match(broken, /leading "\*\/"/, "message should state the fix")
  ok("broken message names the offending rule and the fix")

  // A deny for the map must not be mistaken for an allow.
  assert.equal(verifyWriterRule(config('".opencode/context/**":"deny"'), MAP), undefined)
  ok("deny-only rules are ignored (no allow rule to match, nothing to break)")

  // No config, or no allow rules at all: stay silent rather than cry wolf.
  assert.equal(verifyWriterRule(join(dir, "absent.jsonc"), MAP), undefined)
  ok("missing config file does not raise a false alarm")
  assert.equal(verifyWriterRule(config('"*":"allow"'), MAP), undefined)
  ok("catch-all allow rule is accepted")

  // The detector must track the real opencode.jsonc, not a fixture. If the live
  // config ever regresses to a relative pattern, this fails on the spot.
  const live = verifyWriterRule(new URL("../opencode.jsonc", import.meta.url).pathname, MAP)
  assert.equal(live, undefined, `live config is not writable: ${live}`)
  ok("live opencode.jsonc one-writer rule matches this project's map")

  // …and on every host, since the rule must not be tied to one absolute path.
  for (const other of ["/root/.opencode/context", "/srv/work/app/.opencode/context"]) {
    assert.equal(verifyWriterRule(new URL("../opencode.jsonc", import.meta.url).pathname, other), undefined)
  }
  ok("rule is host-independent (matches /root and /srv maps too)")

  console.log(`\nALL ${checks} PERMISSION CHECKS PASSED`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}