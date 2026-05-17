#!/usr/bin/env node
/**
 * CI gate enforcing the `expected: !isTauri()` ↔ Rust handler contract.
 *
 * For every TS site that invokes `plugin_<name>`, this script:
 *   1. extracts the command name,
 *   2. checks whether a corresponding `#[tauri::command]` exists in any Rust
 *      source file AND is registered through `lib.rs`'s `generate_handler!`,
 *   3. inspects the surrounding `recordSilentFailure({ ..., expected: ... })`
 *      argument.
 *
 * Handler discovery is a two-pass scan:
 *   - Pass A walks every `*.rs` file under `src-tauri/src/plugin_api/` and
 *     `src-tauri/src/plugins/`, plus every plugin-owned Rust source brought
 *     in via `#[path = "../../../../plugins/.../commands.rs"]` (the
 *     `src-tauri/src/plugins/<name>/mod.rs` files declare these). For each
 *     file, collects `#[tauri::command] (pub)? (async)? fn plugin_<name>(`.
 *   - Pass B parses `src-tauri/src/lib.rs` for `generate_handler!(...)` entries
 *     whose final `::` segment matches `plugin_*`.
 *
 * Failures (any one of these exits 1):
 *   - TS site invokes `plugin_X` and the handler is registered, but the site
 *     still uses `expected: !isTauri()` → must flip to `expected: false`.
 *   - TS site uses `expected: false` but the handler is not registered → the
 *     flag was flipped prematurely; revert to `!isTauri()` until the
 *     handler ships.
 *   - A `plugin_*` handler is declared in Rust source but missing from
 *     `generate_handler!` → Tauri will reject invocations at runtime; add
 *     the registration in `lib.rs`.
 *
 * Plain-Node (.mjs) so we don't need a TS runtime in CI. Regex-based —
 * no full parser. Fast (~200ms on the 68-handler audit set).
 *
 * Usage:
 *   node scripts/check-silent-failure-flags.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { resolve, relative, dirname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..")
const LIB_RS = resolve(REPO_ROOT, "src-tauri/src/lib.rs")
const SEARCH_DIRS = ["lib/plugin", "hooks/plugins", "stores/plugin", "stores/plugins"]
const RUST_SOURCE_ROOTS = [
  resolve(REPO_ROOT, "src-tauri/src/plugin_api"),
  resolve(REPO_ROOT, "src-tauri/src/plugins"),
]

function listTsFiles() {
  const cmd = `git -C "${REPO_ROOT}" ls-files ${SEARCH_DIRS.map((d) => `"${d}"`).join(" ")}`
  const out = execSync(cmd, { encoding: "utf8" })
  return out
    .split("\n")
    .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .map((p) => resolve(REPO_ROOT, p))
}

function walkRust(root) {
  const out = []
  if (!existsSync(root)) return out
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        stack.push(full)
      } else if (entry.endsWith(".rs")) {
        out.push(full)
      }
    }
  }
  return out
}

/**
 * Walk the plugin-owned Rust crates brought in via `#[path = "..."]`. The
 * bridge module at `src-tauri/src/plugins/<name>/mod.rs` lists each one with a
 * `#[path = "..."] pub mod ...;` declaration. We resolve the path against the
 * `mod.rs` file's own location, then scan the referenced file.
 */
function externalPathRustFiles() {
  const bridgeRoot = resolve(REPO_ROOT, "src-tauri/src/plugins")
  if (!existsSync(bridgeRoot)) return []
  const pathRe = /#\[path\s*=\s*"([^"]+\.rs)"\s*\]/g
  const seen = new Set()
  const out = []
  const stack = [bridgeRoot]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        stack.push(full)
      } else if (entry === "mod.rs" || entry.endsWith(".rs")) {
        const src = readFileSync(full, "utf8")
        for (const m of src.matchAll(pathRe)) {
          const target = normalize(resolve(dirname(full), m[1]))
          if (!seen.has(target) && existsSync(target)) {
            seen.add(target)
            out.push(target)
          }
        }
      }
    }
  }
  return out
}

function declaredHandlers() {
  // Match: #[tauri::command] (optionally followed by #[…attrs…] lines), then
  // `pub`? `async`? `fn plugin_<name>(`. Capture the name.
  const decl =
    /#\[tauri::command\][^\n]*\n(?:\s*#\[[^\]]+\][^\n]*\n)*\s*(?:pub\s+)?(?:async\s+)?fn\s+(plugin_[A-Za-z0-9_]+)\s*[(<]/g
  const sources = new Map() // handlerName -> [relPath, ...]
  const files = []
  for (const root of RUST_SOURCE_ROOTS) {
    files.push(...walkRust(root))
  }
  files.push(...externalPathRustFiles())
  for (const file of files) {
    const src = readFileSync(file, "utf8")
    for (const m of src.matchAll(decl)) {
      const name = m[1]
      const rel = relative(REPO_ROOT, file)
      if (!sources.has(name)) sources.set(name, [])
      sources.get(name).push(rel)
    }
  }
  return sources
}

function registeredHandlers() {
  const src = readFileSync(LIB_RS, "utf8")
  // Locate the generate_handler! block by name and find the matching closing
  // bracket via bracket-counting. The lazy-regex approach is brittle because
  // commented `(ADR-0022)` etc. inside the macro look like closing parens.
  const markerRe = /generate_handler!\s*(\[|\()/g
  const marker = markerRe.exec(src)
  if (!marker) {
    throw new Error(
      `Could not locate generate_handler!(...) in ${relative(REPO_ROOT, LIB_RS)}; ` +
        `the script's source assumptions are stale.`
    )
  }
  const open = marker[1]
  const close = open === "[" ? "]" : ")"
  let depth = 1
  let cursor = marker.index + marker[0].length
  // Track quotes/line-comments/block-comments so bracket-counting isn't fooled
  // by a `)` or `]` inside a string or comment.
  let inStr = false
  let strQuote = ""
  let inLine = false
  let inBlock = false
  while (cursor < src.length && depth > 0) {
    const ch = src[cursor]
    const next = src[cursor + 1]
    if (inLine) {
      if (ch === "\n") inLine = false
    } else if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false
        cursor += 1
      }
    } else if (inStr) {
      if (ch === "\\") {
        cursor += 1
      } else if (ch === strQuote) {
        inStr = false
      }
    } else if (ch === "/" && next === "/") {
      inLine = true
      cursor += 1
    } else if (ch === "/" && next === "*") {
      inBlock = true
      cursor += 1
    } else if (ch === '"' || ch === "'") {
      inStr = true
      strQuote = ch
    } else if (ch === open) {
      depth += 1
    } else if (ch === close) {
      depth -= 1
      if (depth === 0) break
    }
    cursor += 1
  }
  if (depth !== 0) {
    throw new Error(`Unbalanced ${open}…${close} in generate_handler! starting at ${marker.index}`)
  }
  const entries = src.slice(marker.index + marker[0].length, cursor)
  const handlers = new Set()
  // Every registered plugin_* handler is path-qualified (at least one `::`
  // module prefix). Scan for any path-prefixed plugin_<name> followed by a
  // comma or whitespace.
  for (const m of entries.matchAll(/(?:[A-Za-z_]\w*::)+(plugin_[A-Za-z0-9_]+)\s*[,)]/g)) {
    handlers.add(m[1])
  }
  return handlers
}

function scanFile(path, registered) {
  const issues = []
  const src = readFileSync(path, "utf8")
  const lines = src.split("\n")
  const invokeRe = /invoke[(<][^,)]*["'`](plugin_[A-Za-z0-9_]+)["'`]/

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
  const declared = declaredHandlers()
  const registered = registeredHandlers()
  const declaredKeys = new Set(declared.keys())

  // Handlers in source but missing from generate_handler! — would never reach
  // the runtime even though they exist. This is the failure mode the ADR 0016
  // §4.4 CI gate is meant to catch.
  const orphanedDeclarations = []
  for (const [name, sources] of declared) {
    if (!registered.has(name)) {
      orphanedDeclarations.push({ name, sources })
    }
  }

  const files = listTsFiles()
  const issues = []
  for (const file of files) {
    issues.push(...scanFile(file, registered))
  }

  const totalProblems = orphanedDeclarations.length + issues.length
  if (totalProblems === 0) {
    console.log(
      `[silent-failure-flags] OK: ${files.length} TS files audited, ${registered.size} Rust handlers registered ` +
        `(${declaredKeys.size} declared in source), no flag drift, no orphaned handlers.`
    )
    return 0
  }

  if (orphanedDeclarations.length > 0) {
    console.error(
      `[silent-failure-flags] ${orphanedDeclarations.length} Rust handler(s) declared but NOT registered ` +
        `in generate_handler! — Tauri will reject invocations at runtime:\n`
    )
    for (const { name, sources } of orphanedDeclarations) {
      console.error(`  ${name}  (defined in ${sources.join(", ")})`)
    }
    console.error("")
  }

  if (issues.length > 0) {
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
    console.error("")
  }

  console.error(
    `[silent-failure-flags] ${totalProblems} issue(s). See ADR 0016 §4.4 for the contract.`
  )
  return 1
}

process.exit(main())
