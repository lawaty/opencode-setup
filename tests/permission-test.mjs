// Regression tests for the silent-stale-map failure.
//
// Two rounds of this bug, opposite fixes, both invisible:
//
//   1. The one-writer rule was ".opencode/context/**". The plugin verified it against
//      the ABSOLUTE path, concluded the rule was fine, and every write was denied.
//      prompt() still resolved, so a fully blocked run was indistinguishable from a
//      successful one and the map sat stale for days.
//
//   2. The rule was changed to "*/.opencode/context/**" to match the absolute path.
//      That fixed the verifier and broke the writes again, because opencode does not
//      evaluate the absolute path at all -- see below.
//
// opencode evaluates a file permission against the path RELATIVE TO THE PROJECT ROOT.
// Handing the write tool /repo/.opencode/context/architecture.md is logged and evaluated
// as ".opencode/context/architecture.md". Patterns compile to anchored regexes (* -> .*)
// and the longest match wins, so:
//
//   ".opencode/context/**"    fires for a normally-rooted project, but not when the
//                             project root is "/" (where the form is home/.../...)
//   "*/.opencode/context/**"  fires only when the project root is "/"
//
// Both forms are therefore required. These tests pin the detector that turns this class
// of bug into a startup error instead of a silently stale map.
//
// Run: node ~/.config/opencode/tests/permission-test.mjs
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { verifyWriterRule } from "../src/lib/writer-rule.ts"

const REL = '".opencode/context/**":"allow"'
const ABS = '"*/.opencode/context/**":"allow"'
// This repo, and this repo as seen from a project root of "/". Derived from the
// running user's home rather than hardcoded, so the fixtures are not pinned to
// one machine's username.
const HOME = homedir()
const REPO = `${HOME}/.config/opencode`
const REPO_MAP = `${REPO}/.opencode/context`

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
  // A normally-rooted project is evaluated on the relative form, so the relative rule works.
  assert.equal(verifyWriterRule(config(REL), REPO_MAP, REPO), undefined)
  ok('relative ".opencode/context/**" matches the project-root-relative map path')

  // The rule that broke it: anchored with a leading "*/", so it never fires for a
  // normally-rooted project. The old detector called this correct.
  const broken = verifyWriterRule(config(ABS), REPO_MAP, REPO)
  assert.ok(broken, 'absolute-only "*/" rule must be reported as broken')
  ok('absolute-only "*/.opencode/context/**" is reported as broken')
  assert.match(broken, /not writable/)
  assert.match(broken, /none of the allow rules/)
  assert.match(broken, /RELATIVE TO THE PROJECT ROOT/, "message should state the real cause")
  ok("broken message states the map is not writable and the real cause")
  assert.match(broken, /\.opencode\/context\/\*\*/, "message should name the offending rule")
  assert.match(broken, /Allow both forms/, "message should state the fix")
  ok("broken message names the offending rule and the fix")

  // …but that same rule IS correct when the project root is "/", because the evaluated
  // form is then "home/<you>/.opencode/context/architecture.md".
  assert.equal(verifyWriterRule(config(ABS), REPO_MAP, "/"), undefined)
  ok('absolute "*/" rule accepted when the project root is "/"')

  // Symmetrically, the relative rule is wrong for a project rooted at "/".
  assert.ok(verifyWriterRule(config(REL), REPO_MAP, "/"), 'relative-only rule must fail at root "/"')
  ok('relative-only rule is reported as broken when the project root is "/"')

  // What this repo actually ships: both forms, so every project root is covered.
  assert.equal(verifyWriterRule(config(`${REL},${ABS}`), REPO_MAP, REPO), undefined)
  assert.equal(verifyWriterRule(config(`${REL},${ABS}`), REPO_MAP, "/"), undefined)
  assert.equal(verifyWriterRule(config(`${REL},${ABS}`), "/srv/work/app/.opencode/context", "/srv/work/app"), undefined)
  ok("both rules together cover every project root")

  // A deny for the map must not be mistaken for an allow.
  assert.equal(verifyWriterRule(config('".opencode/context/**":"deny"'), REPO_MAP, REPO), undefined)
  ok("deny-only rules are ignored (no allow rule to match, nothing to break)")

  // No config, or no allow rules at all: stay silent rather than cry wolf.
  assert.equal(verifyWriterRule(join(dir, "absent.jsonc"), REPO_MAP, REPO), undefined)
  ok("missing config file does not raise a false alarm")
  assert.equal(verifyWriterRule(config('"*":"allow"'), REPO_MAP, REPO), undefined)
  ok("catch-all allow rule is accepted")

  // No project root given: fall back to the absolute check rather than guessing.
  assert.equal(verifyWriterRule(config(ABS), REPO_MAP), undefined)
  ok("absolute check still used when no project root is supplied")

  // The detector must track the real opencode.jsonc, not a fixture. If the live config
  // ever drops either form, this fails on the spot.
  const live = new URL("../opencode.jsonc", import.meta.url).pathname
  for (const [root, map] of [
    [REPO, REPO_MAP],
    ["/", `${HOME}/.opencode/context`],
    ["/srv/work/app", "/srv/work/app/.opencode/context"],
  ]) {
    const result = verifyWriterRule(live, map, root)
    assert.equal(result, undefined, `live config not writable for root ${root}: ${result}`)
  }
  ok("live opencode.jsonc is writable for every project root")

  // …and on every host, since the rules must not be tied to one absolute path.
  for (const [root, map] of [
    ["/root", "/root/.opencode/context"],
    ["/srv/work/app", "/srv/work/app/.opencode/context"],
  ]) {
    assert.equal(verifyWriterRule(live, map, root), undefined)
  }
  ok("rule is host-independent (matches /root and /srv maps too)")

  console.log(`\nALL ${checks} PERMISSION CHECKS PASSED`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}