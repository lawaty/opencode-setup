// The coverage guard.
//
// This file is the enforcement mechanism behind "tests cover all stories". Every
// other suite can rot quietly; this one cannot, because it compares the STORIES
// to the TESTS rather than trusting either of them:
//
//   docs/USER-STORIES.md   defines  -> every `### US-N:` heading is a contract
//   tests/stories/*.test.mjs  covers  -> every `[US-N]` marker is a test case
//
// Two directions, because each catches a different rot:
//   * a story in the doc with no test  -> a contract that is not verified
//   * a test naming a story not in the doc -> renumbering drift, where tests
//     kept the old id and now silently certify a different story (or none)
//
// It prints the coverage table so the mapping is auditable at a glance, and it
// is the reason "all 17 are covered" stays true as the doc changes.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { ROOT, STORIES_DOC } from "./_harness.mjs"

const STORIES_DIR = join(ROOT, "tests", "stories")

const doc = readFileSync(STORIES_DOC, "utf8")

/**
 * Every story the doc defines.
 *
 * The heading form is authoritative: `### US-7: Non-free models still work`.
 * The `**Story ID(s) for tests:**` lines are a redundant restatement and are
 * deliberately NOT parsed, so editing them cannot silently change what counts
 * as a story. A doc with no headings at all yields an empty set, which fails the
 * guard below rather than passing vacuously.
 */
const definedStories = () => {
  const ids = new Set()
  for (const match of doc.matchAll(/^###\s+(US-\d+)\s*:/gm)) ids.add(match[1])
  return [...ids].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
}

/**
 * Strip comments, and mask the BODY of every string literal.
 *
 * Both are needed, and getting either wrong makes the guard lie:
 *
 *   * Without comment stripping, `// test("[US-15] …")` still matches, so
 *     commenting out a test leaves its story looking covered.
 *   * Without string masking, a string that merely *mentions* a test call —
 *     including one inside this file's own fixtures — is counted as a real
 *     declaration.
 *
 * Both holes were found by trying to break the guard rather than by reading it.
 *
 * The masked copy keeps every index aligned with the plain copy, so a match
 * found in the masked text can be read verbatim out of the plain one.
 */
const scan = (source) => {
  let plain = ""
  let masked = ""
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++
      i += 2
      // Keep the newlines so line-based checks stay meaningful.
      plain += "\n"
      masked += "\n"
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch
      plain += ch
      masked += ch
      i++
      while (i < source.length) {
        if (source[i] === "\\") {
          plain += source[i] + (source[i + 1] ?? "")
          masked += "\u0000".repeat(1 + (source[i + 1] ? 1 : 0))
          i += 2
          continue
        }
        plain += source[i]
        masked += source[i] === "\n" ? "\n" : "\u0000"
        if (source[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    plain += ch
    masked += ch
    i++
  }
  return { plain, masked }
}

/**
 * Every real `test("…")` declaration in a file, as { index, name }.
 *
 * Located in the masked copy — so only a genuine call site matches — and read
 * out of the plain copy, so the name is the actual text.
 */
const declarations = (source) => {
  const { plain, masked } = scan(source)
  const found = []
  for (const match of masked.matchAll(/(?:^|[\s;{}])test\(\s*"/g)) {
    const at = match.index + match[0].length - 1 // points at the opening quote
    const close = plain.indexOf('"', at + 1)
    if (close > at) found.push({ index: at, name: plain.slice(at + 1, close) })
  }
  return found
}

/** Every test file in the guard's directory, as { name, source }. */
const testFiles = () =>
  readdirSync(STORIES_DIR)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(STORIES_DIR, name), "utf8") }))

/**
 * Story id -> { cases: number, files: string[] }.
 *
 * Both counts matter and they are not the same number: several test cases
 * usually cover one story, and a story split across two files is worth seeing.
 */
const markersByStory = () => {
  const found = new Map()
  for (const { name, source } of testFiles()) {
    for (const { name: testName } of declarations(source)) {
      const id = /^\[(US-\d+)\]/.exec(testName)?.[1]
      if (!id) continue
      const entry = found.get(id) ?? { cases: 0, files: [] }
      entry.cases++
      if (!entry.files.includes(name)) entry.files.push(name)
      found.set(id, entry)
    }
  }
  return found
}

test("[coverage] every story in docs/USER-STORIES.md has at least one test", () => {
  const stories = definedStories()
  assert.ok(stories.length > 0, `no story headings found in ${STORIES_DOC}; the guard cannot verify anything`)

  const covered = markersByStory()
  const uncovered = stories.filter((id) => !covered.has(id))

  if (uncovered.length > 0) {
    assert.fail(
      `these stories have NO test in tests/stories/:\n` +
        uncovered.map((id) => `  ${id}`).join("\n") +
        `\n\nevery story in ${STORIES_DOC} must be covered, or removed from the doc. ` +
        `Add a test whose name starts with "[${uncovered[0]}]".`,
    )
  }
})

test("[coverage] no test references a story the doc does not define", () => {
  const stories = new Set(definedStories())
  assert.ok(stories.size > 0, `no story headings found in ${STORIES_DOC}`)

  const covered = markersByStory()
  const orphans = [...covered.keys()].filter((id) => !stories.has(id)).sort()

  if (orphans.length > 0) {
    assert.fail(
      `these tests reference stories that do not exist in ${STORIES_DOC}:\n` +
        orphans.map((id) => `  ${id}  (used by ${covered.get(id).files.join(", ")})`).join("\n") +
        `\n\nEither the story was renumbered or removed and the tests were not updated. ` +
        `Fix the id in the test name, or fix the doc.`,
    )
  }
})

test("[coverage] a comment or a quoted mention is not a test", () => {
  // The guard's own regressions. Both holes were found by trying to break the
  // guard rather than by reading it: the first version counted a commented-out
  // test, the second counted a string that merely mentioned one.
  const fixture = [
    '// test("[US-1] commented out"',
    '/* test("[US-2] block-commented out" */',
    'const example = \'test("[US-3] only mentioned")\'',
    'test("[US-4] real")',
  ].join("\n")
  const found = declarations(fixture).map((d) => d.name)
  assert.deepEqual(found, ["[US-4] real"], `only a real call site counts, got ${JSON.stringify(found)}`)
})

test("[coverage] every test name that claims a story carries the id in brackets", () => {
  // The mapping is greppable only if the marker is in the NAME. A test that
  // covers US-9 without saying so would silently drop out of this report.
  const offenders = []
  for (const { name, source } of testFiles()) {
    for (const { name: testName } of declarations(source)) {
      if (!/^\[(US-\d+)\]/.test(testName)) offenders.push(`${name}: ${testName}`)
    }
  }
  // coverage.test.mjs is the guard, not a story suite; its own cases are marked
  // [coverage] and are the one legitimate exception.
  const guarded = offenders.filter((line) => !line.startsWith("coverage.test.mjs: [coverage]"))
  assert.deepEqual(guarded, [], `these tests name no story id:\n${guarded.join("\n")}`)
})

test("[coverage] report", () => {
  // Not an assertion so much as the artifact: the table a maintainer reads when
  // a story is added, to see at a glance which epic now has a hole.
  const stories = definedStories()
  const covered = markersByStory()
  const width = Math.max(...stories.map((id) => id.length), 5)

  const table = [
    `  ${"story".padEnd(width)}  cases  files`,
    `  ${"-".repeat(width + 25)}`,
    ...stories.map((id) => {
      const { cases, files } = covered.get(id) ?? { cases: 0, files: [] }
      return `  ${id.padEnd(width)}  ${String(cases).padStart(5)}  ${files.join(", ")}`
    }),
  ].join("\n")

  console.log(`\n  user-story coverage — ${stories.length} stories from docs/USER-STORIES.md\n`)
  console.log(table)
  const cases = stories.reduce((sum, id) => sum + (covered.get(id)?.cases ?? 0), 0)
  const weakest = stories.reduce((min, id) => Math.min(min, covered.get(id)?.cases ?? 0), Infinity)
  console.log(`\n  ${stories.length}/${stories.length} stories covered by ${cases} test case(s); thinnest story has ${weakest}.`)
  console.log(`  No story is untested.\n`)

  assert.ok(cases > 0, "the report must actually have found tests to report")
})