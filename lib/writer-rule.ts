import { readFileSync } from "node:fs"
import * as path from "node:path"

// A plugin module's exports ARE its plugins: opencode iterates every export of a
// plugin file and calls it, then uses the return value as a hooks object
// (Plugin.init -> Wy/Gy -> hooks.push(await fn(input, options))). So this lives in
// lib/, not in plugins/context-autoupdate.ts. Exported from a plugin file it is
// invoked with the plugin input as its arguments; readFileSync then throws EISDIR,
// the catch below swallows it, and the plugin registry is left holding undefined.
// Every later hook dispatch then fails on that entry ("undefined is not an object
// (evaluating 'hooks.config')"), taking the whole process down.

const CONTEXT_DIR = path.join(".opencode", "context")

const toPosix = (value: string) => value.split(path.sep).join("/")

// Verifies the one-writer permission rule actually matches this project's map.
//
// opencode evaluates a file permission against the path RELATIVE TO THE PROJECT ROOT,
// not the absolute path the tool was handed: a write of
// /repo/.opencode/context/architecture.md is logged and evaluated as
// ".opencode/context/architecture.md". Patterns compile to anchored regexes (* -> .*)
// and the longest match wins, so neither form covers every project on its own:
//
//   ".opencode/context/**"    fires for a normally-rooted project, but not when the
//                             project root is "/" (the form is then home/.../...)
//   "*/.opencode/context/**"  fires only when the project root is "/"
//
// So the rule to check is whichever form applies to THIS project's root. Checking the
// absolute path instead is what let commit 6f6af0a "fix" a working rule into a silently
// broken one. Reproduced here so a malformed rule is reported at startup instead of
// discovered weeks later as a silently stale map.
export const verifyWriterRule = (configPath: string, mapDir: string, projectRoot?: string) => {
  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch {
    return undefined // no config to inspect (custom config path, or stripped deploy)
  }
  const compile = (pattern: string) => {
    const escaped = toPosix(pattern)
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    return new RegExp(`^${escaped}$`, "s")
  }
  const rules: string[] = []
  for (const block of raw.matchAll(/"(edit|write)"\s*:\s*\{([^}]*)\}/g)) {
    for (const rule of block[2].matchAll(/"((?:[^"\\]|\\.)*)"\s*:\s*"(allow|ask|deny)"/g)) {
      if (rule[2] === "allow") rules.push(rule[1].replace(/\\"/g, '"'))
    }
  }
  if (rules.length === 0) return undefined

  const absolute = toPosix(path.join(mapDir, "architecture.md"))
  const form = projectRoot ? toPosix(path.relative(projectRoot, absolute)) : absolute
  if (rules.some((rule) => compile(rule).test(form))) return undefined

  return `context map is not writable: none of the allow rules in ${path.basename(configPath)} match `
    + (projectRoot
        ? `the project-root-relative form "${form}" that opencode actually evaluates for project root ${toPosix(projectRoot)}`
        : `the absolute form "${form}"`)
    + `. Rules seen: ${rules.map((r) => `"${r}"`).join(", ")}. opencode evaluates file permissions against the path RELATIVE TO THE PROJECT ROOT, so `
    + `"${CONTEXT_DIR}/**" is what fires for a normally-rooted project while "*/${CONTEXT_DIR}/**" only fires when the project root is "/". Allow both forms.`
}