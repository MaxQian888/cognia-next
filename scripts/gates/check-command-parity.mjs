#!/usr/bin/env node
/**
 * CI gate: every literal `invoke("command")` in the renderer must name a
 * command registered in `src-tauri/src/lib.rs`'s `generate_handler!` block.
 *
 * A mistyped or unregistered command name otherwise fails only at runtime as a
 * rejected promise — this repo's most recurrent defect class (built-but-dormant
 * commands). The registered set is parsed by scripts/gates/lib/generate-handler.mjs
 * (same parser the silent-failure-flags gate uses).
 *
 * Scope and known blind spots (by design):
 *   - Only literal first arguments are checked. Dynamic dispatchers pass a
 *     variable and are invisible to this gate. Known dynamic sites include:
 *     lib/connectors/tauri/commands.ts, lib/tauri/transport-tauri.ts,
 *     lib/ai/agent/external/agent-transport.ts, lib/keyring/index.ts,
 *     lib/scheduler/daemon-bridge.ts, lib/workflow/runtime/tauri-bridge.ts,
 *     lib/appearance/load-system-fonts.ts, lib/terminal/completion/*-provider.ts,
 *     and constant-indirection in lib/cli-bridge/, lib/sync/desktop-sync-source.ts,
 *     lib/companion/desktop-message-source.ts. The gate prints an INFO count of
 *     non-literal invoke calls so growth in dynamic dispatch stays visible.
 *   - Tauri plugin commands (`invoke("plugin:dialog|open")`) never match the
 *     identifier-only command regex and are out of scope.
 *   - Registered-but-never-invoked commands are reported informationally but
 *     never fail the gate (CLI/companion/dynamic paths invoke them legitimately).
 *
 * Escape hatch: append `// invoke-parity-exempt: <reason>` on the offending
 * line or the line directly above it. A bare marker without a reason is itself
 * a failure.
 *
 * Usage:
 *   node scripts/gates/check-command-parity.mjs
 */

import { readFileSync, realpathSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"
import { parseRegisteredCommands } from "./lib/generate-handler.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../..")
const LIB_RS = resolve(REPO_ROOT, "src-tauri/src/lib.rs")
const SEARCH_DIRS = ["app", "components", "hooks", "stores", "lib"]

// Literal command: invoke("name") / invoke<T>("name"), identifier-only names.
const INVOKE_LITERAL_RE = /\binvoke\s*(?:<[^>()]*>)?\s*\(\s*(["'`])([A-Za-z_][A-Za-z0-9_]*)\1/g
// Any invoke call whose first argument is NOT a string literal (dynamic dispatch).
const INVOKE_DYNAMIC_RE = /\binvoke\s*(?:<[^>()]*>)?\s*\(\s*(?!["'`])[A-Za-z_$([]/g
const EXEMPT_RE = /\/\/\s*invoke-parity-exempt:(.*)$/

export function listSourceFiles() {
  const cmd = `git -C "${REPO_ROOT}" ls-files ${SEARCH_DIRS.map((d) => `"${d}"`).join(" ")}`
  return execSync(cmd, { encoding: "utf8" })
    .split("\n")
    .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"))
    .filter(
      (p) =>
        !/\.(test|stories)\.tsx?$/.test(p) && !p.includes("__tests__/") && !p.includes("__mocks__/")
    )
}

function lineNumberAt(src, index) {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (src[i] === "\n") line += 1
  }
  return line
}

/**
 * Scan one file's source. Returns { violations, badExempts, dynamicCount }.
 * A violation: literal invoke of an unregistered command without a valid
 * exempt marker. A badExempt: exempt marker present but reason empty.
 */
export function scanSource(relPath, src, registered) {
  const violations = []
  const badExempts = []
  const lines = src.split("\n")

  const exemptState = (lineIdx) => {
    for (const idx of [lineIdx, lineIdx - 1]) {
      if (idx < 0) continue
      const m = lines[idx].match(EXEMPT_RE)
      if (m) return m[1].trim() === "" ? "bare" : "valid"
    }
    return "none"
  }

  for (const m of src.matchAll(INVOKE_LITERAL_RE)) {
    const command = m[2]
    if (registered.has(command)) continue
    const line = lineNumberAt(src, m.index)
    const exempt = exemptState(line - 1)
    if (exempt === "valid") continue
    if (exempt === "bare") {
      badExempts.push({ file: relPath, line, command })
      continue
    }
    violations.push({ file: relPath, line, command })
  }

  const dynamicCount = [...src.matchAll(INVOKE_DYNAMIC_RE)].length
  return { violations, badExempts, dynamicCount }
}

function main() {
  const registered = parseRegisteredCommands(readFileSync(LIB_RS, "utf8"))
  const files = listSourceFiles()

  const violations = []
  const badExempts = []
  const invokedLiterals = new Set()
  let dynamicTotal = 0

  for (const rel of files) {
    const src = readFileSync(resolve(REPO_ROOT, rel), "utf8")
    for (const m of src.matchAll(INVOKE_LITERAL_RE)) invokedLiterals.add(m[2])
    const result = scanSource(rel, src, registered)
    violations.push(...result.violations)
    badExempts.push(...result.badExempts)
    dynamicTotal += result.dynamicCount
  }

  const neverInvoked = [...registered].filter((name) => !invokedLiterals.has(name))

  if (violations.length === 0 && badExempts.length === 0) {
    console.log(
      `[command-parity] OK: ${files.length} TS files audited, ` +
        `${invokedLiterals.size} distinct literal commands all registered ` +
        `(${registered.size} total registered).`
    )
    console.log(
      `[command-parity] INFO: ${dynamicTotal} non-literal invoke call(s) not checked; ` +
        `${neverInvoked.length} registered command(s) with no literal invoke ` +
        `(CLI/companion/dynamic paths — informational only).`
    )
    return 0
  }

  if (violations.length > 0) {
    console.error(
      `[command-parity] ${violations.length} literal invoke(s) of unregistered command(s):\n`
    )
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  invoke("${v.command}") — not in generate_handler!`)
    }
    console.error(
      `\n  Register the command in src-tauri/src/lib.rs, fix the typo, or append\n` +
        `  \`// invoke-parity-exempt: <reason>\` on the line (or the line above).\n`
    )
  }

  if (badExempts.length > 0) {
    console.error(
      `[command-parity] ${badExempts.length} exempt marker(s) without a reason ` +
        `(a bare marker is not an exemption):\n`
    )
    for (const v of badExempts) {
      console.error(`  ${v.file}:${v.line}  invoke("${v.command}")`)
    }
    console.error("")
  }

  console.error(`[command-parity] ${violations.length + badExempts.length} issue(s).`)
  return 1
}

// realpath both sides: on macOS the tmpdir is symlinked (/var → /private/var)
// and node resolves the ESM entry to its realpath, so a plain compare misses.
const isDirectRun = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isDirectRun) {
  process.exit(main())
}
