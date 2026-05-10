#!/usr/bin/env node
/**
 * CI gate enforcing the `expected: !isTauri()` ↔ Rust handler contract.
 *
 * For every TS site that invokes `plugin_<name>`, this script:
 *   1. extracts the command name,
 *   2. checks whether `src-tauri/src/lib.rs` registers a handler for it,
 *   3. inspects the surrounding `recordSilentFailure({ ..., expected: ... })`
 *      argument.
 *
 * Failures:
 *   - Handler exists in lib.rs but the TS site still uses
 *     `expected: !isTauri()` → flag must flip to `expected: false`.
 *   - TS site uses `expected: false` but no handler is registered → the
 *     flag was flipped prematurely; revert to `!isTauri()` until the
 *     handler ships.
 *
 * Plain-Node (.mjs) so we don't need a TS runtime in CI. Regex-based —
 * no full parser. Fast (~150ms on the 82-handler audit set).
 *
 * Usage:
 *   node scripts/check-silent-failure-flags.mjs
 */

import { readFileSync } from "node:fs"
import { resolve, relative, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..")
const LIB_RS = resolve(REPO_ROOT, "src-tauri/src/lib.rs")
const SEARCH_DIRS = ["lib/plugin", "hooks/plugins", "stores/plugin", "stores/plugins"]

function listFiles() {
  const cmd = `git -C "${REPO_ROOT}" ls-files ${SEARCH_DIRS.map((d) => `"${d}"`).join(" ")}`
  const out = execSync(cmd, { encoding: "utf8" })
  return out
    .split("\n")
    .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .map((p) => resolve(REPO_ROOT, p))
}

function registeredHandlers() {
  const src = readFileSync(LIB_RS, "utf8")
  const handlers = new Set()
  for (const match of src.matchAll(/plugin_api::[a-z_]+::(plugin_[a-z_]+)/g)) {
    handlers.add(match[1])
  }
  return handlers
}

function scanFile(path, registered) {
  const issues = []
  const src = readFileSync(path, "utf8")
  const lines = src.split("\n")
  const invokeRe = /invoke[(<][^,)]*["'`](plugin_[a-z_][a-z0-9_]*)["'`]/

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(invokeRe)
    if (!m) continue
    const command = m[1]
    const window = lines.slice(i, Math.min(lines.length, i + 30)).join("\n")
    const flagMatch = window.match(/recordSilentFailure\([\s\S]*?expected:\s*([^,\n}]+)/)
    if (!flagMatch) continue
    const current = flagMatch[1].trim()
    const handlerExists = registered.has(command)
    if (handlerExists && current === "!isTauri()") {
      issues.push({ file: path, line: i + 1, command, current, expected: "false" })
    } else if (!handlerExists && current === "false") {
      issues.push({ file: path, line: i + 1, command, current, expected: "!isTauri()" })
    }
  }
  return issues
}

function main() {
  const registered = registeredHandlers()
  const files = listFiles()
  const issues = []
  for (const file of files) {
    issues.push(...scanFile(file, registered))
  }
  if (issues.length === 0) {
    console.log(
      `[silent-failure-flags] OK: ${files.length} TS files audited, ${registered.size} Rust handlers registered, no flag drift.`
    )
    return 0
  }
  console.error(`[silent-failure-flags] ${issues.length} mismatched flags:\n`)
  for (const issue of issues) {
    const rel = relative(REPO_ROOT, issue.file)
    const reason =
      issue.expected === "false"
        ? `Rust handler '${issue.command}' is registered → flip to expected: false`
        : `Rust handler '${issue.command}' is NOT registered → revert to expected: !isTauri()`
    console.error(`  ${rel}:${issue.line}  ${reason}`)
    console.error(`    current: expected: ${issue.current}`)
    console.error(`    expected: expected: ${issue.expected}`)
  }
  console.error(
    `\n[silent-failure-flags] ${issues.length} issue(s). See ADR 0016 §4.4 for the contract.`
  )
  return 1
}

process.exit(main())
