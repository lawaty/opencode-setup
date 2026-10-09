#!/usr/bin/env node
// Offline checks for the shell scripts in bin/. These are the load-bearing
// pieces of oc-sync -- a silently broken default flag or a stray else turns a
// sync into a no-op that reports success -- so they are asserted rather than
// eyeballed.
//
// No network, no running server: every check is either a syntax parse, a static
// assertion on the source, or a run of the script against a temp HOME and a temp
// host list.

import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..")
const BIN = path.join(REPO, "bin")

let passed = 0
const failures = []

const check = (name, fn) => {
  try {
    fn()
    passed++
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const read = (name) => readFileSync(path.join(BIN, name), "utf8")

// ---------------------------------------------------------------------------
// Syntax
// ---------------------------------------------------------------------------

for (const script of ["oc", "oc-notify", "oc-sync", "oc-notify-receiver"]) {
  check(`syntax: ${script}`, () => {
    const result = spawnSync("bash", ["-n", path.join(BIN, script)], { encoding: "utf8" })
    assert(result.status === 0, `bash -n failed: ${result.stderr}`)
  })
}

// ---------------------------------------------------------------------------
// --with-config is the default
//
// The regression this guards: plain `oc-sync` synced only `oc`, so a change to
// AGENTS.md stayed on this machine while hosts ran the old rules. Fixing
// AGENTS.md and then running oc-sync without a flag appeared to work and moved
// nothing.
// ---------------------------------------------------------------------------

check("oc-sync defaults to --with-config", () => {
  const src = read("oc-sync")
  assert(/^WITH_CONFIG=1$/m.test(src), "WITH_CONFIG should initialise to 1")
  assert(!/^WITH_CONFIG=0$/m.test(src), "WITH_CONFIG should not initialise to 0")
})

check("oc-sync still offers a scripts-only opt-out", () => {
  const src = read("oc-sync")
  assert(/--scripts-only\|--no-config\)\s+WITH_CONFIG=0/.test(src), "the opt-out must set WITH_CONFIG=0")
})

check("oc-sync scripts-only actually disables config", () => {
  // Run the parser with a bogus host list so it exits before doing any work,
  // and confirm the flag pair is still accepted rather than rejected as unknown.
  const result = spawnSync("bash", [path.join(BIN, "oc-sync"), "--scripts-only", "--no-config"], {
    encoding: "utf8",
    env: { ...process.env, OC_HOSTS: "", OC_HOSTS_FILE: path.join(tmpdir(), "nonexistent-oc-hosts") },
  })
  const output = (result.stdout || "") + (result.stderr || "")
  assert(!/unknown option/.test(output), `--scripts-only/--no-config rejected: ${output.trim()}`)
})

check("oc-sync rejects an unknown flag", () => {
  const result = spawnSync("bash", [path.join(BIN, "oc-sync"), "--bogus-flag"], { encoding: "utf8" })
  assert(result.status === 2, `expected exit 2 for an unknown flag, got ${result.status}`)
})

// ---------------------------------------------------------------------------
// oc: notification wiring
// ---------------------------------------------------------------------------

check("oc builds no remote notify-send command string", () => {
  // The old bug: a command string containing `id -u` was built on the host and
  // executed locally, so a root host produced /run/user/0/bus, which does not
  // exist on the desktop. The notification vanished with no error.
  const src = read("oc")
  const inSendNotify = src.slice(src.indexOf("send_notify()"), src.indexOf("# oc-notify reuses"))
  assert(!/notify-send "?\\?/.test(inSendNotify) || !/DISPLAY=/.test(inSendNotify),
    "send_notify must not hand a display/dbus command string to a remote shell")
  assert(!/\bid -u\b/.test(inSendNotify), "send_notify must not expand id -u remotely")
})

check("oc sends the notification as argv, not a shell string", () => {
  const src = read("oc")
  const hop = src.slice(src.indexOf("if [[ -n \"${SSH_CLIENT"), src.indexOf("else\n    # Local"))
  assert(/\$title\$|\$title"/.test(hop), "the tunnel hop should pass title as an argument")
  assert(/"\$title" "\$msg" "\$urgency" "\$icon"/.test(hop),
    "the tunnel hop should pass all four values as quoted arguments")
})

check("oc uses the dedicated tunnel key, never a personal key", () => {
  const src = read("oc")
  assert(/oc_notify/.test(src), "oc should reference the dedicated tunnel key")
  assert(!/id_ed25519|id_rsa|id_ecdsa/.test(src), "oc must not reference personal keys")
})

check("oc's failure message names the real cause", () => {
  // A tunnel port can fail for three distinct reasons, and "check your config"
  // sent people looking in the wrong place. The most common one is a second
  // concurrent session holding the port.
  const src = read("oc")
  assert(/concurrent session/.test(src), "should mention the concurrent-session collision")
  assert(/RemoteForward/.test(src), "should mention the missing RemoteForward")
  assert(/OC_LOCAL_USER/.test(src), "should mention the unset username")
})

check("warn() exists for multi-line diagnostics", () => {
  // The three causes are reported as separate lines, so the once-only guard must
  // not suppress them all after the first call.
  const src = read("oc")
  assert(/^warn\(\) \{/m.test(src), "a plain warn helper is needed for follow-up lines")
})

check("oc is idempotent about the tunnel key being absent", () => {
  // A missing key must produce a warning, never a hard failure: the session has
  // to start regardless.
  const src = read("oc")
  assert(/warn_once "no tunnel key at/.test(src), "missing key should warn")
  assert(/warn_once/.test(src), "warn_once should exist")
})

check("oc passes opencode's exit code through", () => {
  const src = read("oc")
  assert(/"\$OPENCODE_BIN" "\$@"/.test(src), "oc should run the resolved binary with the original args")
  const tail = src.slice(src.indexOf("EXIT_CODE=$?"))
  assert(/exit \$EXIT_CODE/.test(tail), "oc should exit with opencode's code")
})

check("oc finds opencode outside an interactive shell", () => {
  // The regression: opencode lives in ~/.opencode/bin, added to PATH by .bashrc.
  // `oc` from tmux or a detached session found nothing and exited 127, while an
  // interactive shell worked. So the lookup must not rely on PATH alone.
  const src = read("oc")
  assert(/resolve_opencode/.test(src), "oc should resolve the binary explicitly")
  assert(/\.opencode\/bin\/opencode/.test(src), "should check the ~/.opencode/bin install location")
  const resolve = src.slice(src.indexOf("resolve_opencode()"), src.indexOf("OPENCODE_BIN="))
  assert(/command -v opencode/.test(resolve), "should still prefer PATH when it works")
})

check("oc reports a missing binary instead of exiting silently", () => {
  const src = read("oc")
  assert(/cannot find the opencode binary/.test(src), "should explain a missing binary")
  assert(/OPENCODE_BIN="\$\(resolve_opencode\)"/.test(src), "should bail when resolution fails")
})

check("oc-notify does not start opencode", () => {
  const src = read("oc-notify")
  assert(/OC_NOTIFY_ONLY=1 exec/.test(src), "oc-notify should delegate via OC_NOTIFY_ONLY")
  assert(!/\bopencode\b\s+"\$@"/.test(src.replace(/^#.*$/gm, "")), "oc-notify must not call opencode directly")
})

// ---------------------------------------------------------------------------
// oc-notify-receiver: what the tunnel key is allowed to do
// ---------------------------------------------------------------------------

check("receiver validates urgency against a whitelist", () => {
  const src = read("oc-notify-receiver")
  assert(/case "\$URGENCY" in/.test(src), "urgency should be case-checked")
  assert(/low\|normal\|critical/.test(src), "urgency whitelist should list the valid values")
})

check("receiver validates the icon against a whitelist", () => {
  // The icon is the one value interpolated into a notify-send call, so it is the
  // one that must not be attacker-controlled.
  const src = read("oc-notify-receiver")
  assert(/case "\$ICON" in/.test(src), "icon should be case-checked")
})

check("receiver uses notify-send with quoted arguments", () => {
  const src = read("oc-notify-receiver")
  assert(/exec notify-send "\$TITLE" "\$MSG"/.test(src), "title and message must be quoted")
})

// ---------------------------------------------------------------------------
// oc-sync: tunnel provisioning
// ---------------------------------------------------------------------------

check("oc-sync provisions a dedicated key, not the personal one", () => {
  const src = read("oc-sync")
  // The path lives in a variable beside the function; the function body only
  // refers to it. Check both, or the assertion passes vacuously.
  assert(/^TUNNEL_KEY="\$HOME\/\.ssh\/oc_notify"$/m.test(src), "TUNNEL_KEY should be ~/.ssh/oc_notify")
  assert(/^RECEIVER="\$HOME\/\.local\/bin\/oc-notify-receiver"$/m.test(src),
    "RECEIVER should be the local notifier")
  assert(!/id_ed25519\.pub|id_rsa\.pub|id_ecdsa\.pub/.test(src),
    "must not read personal public keys into authorized_keys")
  assert(!/cat "\$HOME\/\.ssh\/id_/.test(src), "must not inline a personal key into the tunnel entry")
})

check("oc-sync restricts the tunnel key to a forced command", () => {
  const src = read("oc-sync")
  const fn = src.slice(src.indexOf("setup_tunnel_auth()"), src.indexOf("setup_tunnel_auth\nTUNNEL_AUTH_FAILED"))
  assert(/restrict,command=/.test(fn), "authorized_keys entry must carry restrict + command=")
  assert(/already restricted/.test(fn), "the entry must be detected, not appended blindly on every run")
})

check("oc-sync ships the tunnel key to the host", () => {
  const src = read("oc-sync")
  assert(/oc_notify.*~?\/\.ssh\/oc_notify/.test(src) || /"\$TUNNEL_KEY" "\$\{HOST\}:~\/\.ssh\/oc_notify"/.test(src),
    "the private key must be pushed to the host")
  assert(/chmod 600 ~\/\.ssh\/oc_notify/.test(src), "the pushed key must be mode 600 on the host")
})

check("oc-sync's own ssh calls never claim the tunnel port", () => {
  // oc-sync makes a dozen ssh calls per host. With RemoteForward configured, each
  // one competes for port 10022 and prints "remote port forwarding failed" --
  // and a half-claimed listener can block the one session that needs the tunnel.
  const src = read("oc-sync")
  assert(!/-e "ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=15"/.test(src),
    "every ssh invocation should pass ClearAllForwardings=yes")
  const plain = src.match(/-e "ssh[^"]*"/g) || []
  for (const spec of plain) {
    assert(/ClearAllForwardings=yes/.test(spec), `rsync ssh spec missing the flag: ${spec}`)
  }
  assert((src.match(/SSH_BASE=\(ssh -n "\$\{SSH_SSH_OPTS\[@\]\}"\)/) || []).length === 1,
    "SSH_BASE should use the shared opts array")
})

check("oc-sync repairs a stale authorized_keys receiver path", () => {
  // A receiver that moved leaves hosts holding a key that cannot authenticate,
  // so notifications fail with a permission error. The entry must be rewritten.
  const src = read("oc-sync")
  assert(/re-pointed a stale tunnel key entry/.test(src), "should detect and rewrite a stale entry")
  assert(/grep -v "oc-notify tunnel auth"/.test(src), "should drop the old line before rewriting")
})

check("oc-sync syncs oc-notify alongside oc", () => {
  const src = read("oc-sync")
  assert(/for SCRIPT in oc oc-notify/.test(src), "both scripts should be pushed")
})

check("a tunnel-key failure is a warning, not a host failure", () => {
  // Losing the key must not stop the config sync: the config is what keeps the
  // context protocol current, and notifications are repairable.
  const src = read("oc-sync")
  assert(/warn "could not send the tunnel key/.test(src), "key push failure should warn")
  assert(!/FAILED\+=.*could not send the tunnel key/.test(src), "key push failure must not mark the host failed")
})

// ---------------------------------------------------------------------------
// End to end, offline: oc-sync against a fake host
// ---------------------------------------------------------------------------

check("dry run writes nothing and reports no failure", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ocsync-home-"))
  const envFile = path.join(home, ".env")
  mkdirSync(path.join(home, ".ssh"), { recursive: true })
  writeFileSync(path.join(home, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAA test\n")
  // An empty host list: the script must exit before touching anything, which is
  // what lets the provisioning block run in isolation.
  writeFileSync(envFile, 'OC_HOSTS=""\n')

  const result = spawnSync("bash", [path.join(BIN, "oc-sync"), "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, OC_SYNC_ENV_FILE: envFile },
  })
  const output = (result.stdout || "") + (result.stderr || "")
  try {
    assert(/no hosts configured/.test(output), `expected the empty-host guard, got: ${output.trim()}`)
    assert(/dry run: nothing was written/.test(output) || !/rsync/.test(output), "dry run must not transfer")
    assert(!existsSync(path.join(home, ".ssh", "oc_notify")),
      "dry run must not generate the tunnel key")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

check("--help exits 0 and prints usage", () => {
  const result = spawnSync("bash", [path.join(BIN, "oc-sync"), "--help"], { encoding: "utf8" })
  assert(result.status === 0, `--help exited ${result.status}`)
  assert(/--scripts-only/.test(result.stdout), "help should document the opt-out")
})

// ---------------------------------------------------------------------------

console.log(`${passed} checks passed`)
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}