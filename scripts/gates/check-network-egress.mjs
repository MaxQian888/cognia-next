#!/usr/bin/env node
/**
 * Gate: every outbound network call on the desktop Host goes through a
 * transport that knows about the proxy.
 *
 * ## Why this exists
 *
 * The packaged desktop shell serves the renderer under a static CSP whose
 * `connect-src` is `'self' ipc: http://ipc.localhost ws: wss:`. A renderer
 * `fetch("https://anything")` — or `new WebSocket`, or `new EventSource` — is
 * blocked before it leaves the WebView, and even where it is not, it never
 * sees the Off/Manual/Auto proxy the user configured, its bypass list, or its
 * keyring credentials. Those live in Rust.
 *
 * `pnpm dev` has no CSP. That is the whole problem: a bare `fetch` looks
 * perfectly healthy in development and is dead in the packaged app. It has
 * shipped that way repeatedly here — the OTLP/Langfuse log transports, the
 * entire local-provider surface, web search, RAG reranking, cloud OCR, the
 * Site preview readiness probe. Each was found by hand, months later.
 *
 * Code review does not catch this: `await fetch(url)` is the most ordinary
 * line in the language. A gate does.
 *
 * ## What counts as an egress
 *
 * TypeScript:
 *   - a call to the global `fetch`
 *   - `new WebSocket(...)`
 *   - `new EventSource(...)`
 *
 * Rust:
 *   - `reqwest::Client::new()` — no policy can be applied to it
 *   - `.no_proxy()` — an explicit opt-out of the policy
 *
 * ## The approved paths
 *
 * TS: `proxyFetch` / `createPlatformFetch` (buffered),
 * `createPlatformStreamingFetch` (SSE, NDJSON, large bodies),
 * `createPlatformWebSocket` (WSS). Rust: `apply_reqwest_policy` /
 * `managed_client` / `wsproxy::connect_via_proxy`.
 *
 * ## Exceptions
 *
 * Declared one entry at a time in `network-egress-allowlist.json`, each with a
 * `reason` from a fixed vocabulary. Directory-level wildcards are rejected on
 * purpose: an exception that covers a whole tree stops being read and starts
 * being a hole. An entry whose findings have disappeared is also an error —
 * a stale exception silently re-opens the next bare call written on that line.
 *
 * Usage:
 *   node scripts/gates/check-network-egress.mjs
 *   node scripts/gates/check-network-egress.mjs --write-baseline
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../..")
const ALLOWLIST_PATH = resolve(__dirname, "network-egress-allowlist.json")

/** Roots whose code can run in the desktop renderer or the Rust host. */
export const TS_ROOTS = ["app", "components", "hooks", "lib", "packages", "plugins", "stores"]
export const RUST_ROOTS = ["crates", "src-tauri/src"]

/**
 * Why an egress may stay unmanaged. Fixed vocabulary — a free-text reason
 * degrades into "because it was there".
 */
export const REASONS = new Set([
  // Talks to 127.0.0.1 / a unix socket that the proxy must never intercept.
  "loopback",
  // Reads a blob:, data:, or bundled asset URL — never a network origin.
  "resource-read",
  // The non-Tauri leg of a call that uses a native command on the desktop.
  "browser-fallback",
  // Capacitor's own native HTTP plugin, or the mobile shell's WebView.
  "capacitor",
  // The companion transport, which pins its own TLS and must not be re-routed.
  "companion-pinned",
  // Runs in Node (headless brain, CLI, sidecar, build script), where the
  // process environment carries the proxy instead.
  "server-side",
  // Test scaffolding, fixtures, or a generated-code template.
  "test",
  // The managed transport's own implementation — the one place a bare call
  // is the point.
  "transport-impl",
])

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

/**
 * Files whose egress is scaffolding, not product code.
 *
 * Excluded rather than allowlisted: a test that stubs `fetch` is not a policy
 * decision anyone needs to review, and 40 such entries would bury the ones
 * that are.
 */
export function isScaffolding(file) {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /\.stories\.[jt]sx?$/.test(file) ||
    file.includes("/__mocks__/") ||
    file.includes("/__fixtures__/") ||
    /(?:^|\/)tests?\//.test(file) ||
    /(?:^|\/)benches\//.test(file)
  )
}

/**
 * Which of `git ls-files`\' lines this gate should actually open.
 *
 * `exists` is a required argument rather than a defaulted one because the
 * whole point of this function is the third filter, and a default would be the
 * one branch every test stubs away.
 *
 * That third filter is not bookkeeping. `git ls-files` still lists a tracked
 * file that has been deleted from disk but not staged, and reading one threw
 * ENOENT straight out of `collectFindings` — so the gate CRASHED instead of
 * reporting. A crash is not a verdict: it says nothing about the egress in the
 * rest of the tree, and it hid 20 real unmanaged call sites for as long as one
 * unstaged deletion existed. A tree with unstaged deletions is ordinary
 * (mid-refactor, or another session sharing the checkout), so a deleted file is
 * simply not there to scan. `check-static-export.mjs:listSourceFiles` has
 * carried this same guard from the start.
 *
 * @param {string[]} lines raw `git ls-files` output lines
 * @param {string[]} extensions file suffixes this pass understands
 * @param {(file: string) => boolean} exists is the path still on disk
 * @returns {string[]}
 */
export function selectScannableFiles(lines, extensions, exists) {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && extensions.some((ext) => line.endsWith(ext)))
    .filter((line) => !isScaffolding(line))
    .filter((line) => exists(line))
}

function listFiles(roots, extensions) {
  const out = execSync(`git -C "${REPO_ROOT}" ls-files ${roots.map((r) => `"${r}"`).join(" ")}`, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return selectScannableFiles(out.split("\n"), extensions, (file) =>
    existsSync(resolve(REPO_ROOT, file))
  )
}

/**
 * Blank out string/template/comment content so a `fetch(` inside a doc comment
 * or a generated-code template is not read as a call. Positions are preserved
 * (each removed character becomes a space) so line/column arithmetic still
 * works on the result.
 */
export function blankNonCode(source) {
  const out = source.split("")
  let index = 0
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " "
    }
  }
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index)
      blank(index, end === -1 ? source.length : end)
      index = end === -1 ? source.length : end
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2
          continue
        }
        if (source[cursor] === char) break
        cursor += 1
      }
      blank(index + 1, cursor)
      index = cursor + 1
      continue
    }
    index += 1
  }
  return out.join("")
}

/**
 * Blank an inline `#[cfg(test)] mod … { … }` body.
 *
 * Rust keeps its unit tests in the source file, and those tests build bare
 * `reqwest::Client::new()` clients by design. Without this they would each
 * need an allowlist entry that says nothing.
 */
export function blankRustTestModules(code) {
  const out = code.split("")
  const pattern = /#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+[\w]+\s*\{/g
  let match
  while ((match = pattern.exec(code)) !== null) {
    const open = code.indexOf("{", match.index + match[0].length - 1)
    let depth = 0
    let end = code.length
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1
      else if (code[i] === "}") {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    for (let i = match.index; i <= end && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " "
    }
  }
  return out.join("")
}

/** Index → 1-based line number. */
function lineAt(source, index) {
  let line = 1
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1
  }
  return line
}

/** Position of the `)` closing the `(` at `openIndex`, or -1. */
function matchParen(source, openIndex) {
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1
    else if (source[i] === ")") {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Find bare-`fetch` CALL sites, excluding declarations.
 *
 * Three shapes look identical to a naive regex and are not calls:
 *   `async fetch(ref: Ref)` (a class/object method), `fetch(remote?: string)`
 *   (an interface member), and `fetch(ctx) { … }` (an object literal method).
 * A typed parameter or a following `{` gives each of them away.
 */
/** The argument list up to its first depth-0 comma. */
export function firstTopLevelArgument(args) {
  let depth = 0
  for (let i = 0; i < args.length; i += 1) {
    const char = args[i]
    if (char === "(" || char === "[" || char === "{") depth += 1
    else if (char === ")" || char === "]" || char === "}") depth -= 1
    else if (char === "," && depth === 0) return args.slice(0, i)
  }
  return args
}

/** `name: Type` / `name?: Type` — a declaration's first parameter. */
export function isTypedParameter(segment) {
  return /^\s*\.{0,3}\s*[A-Za-z_$][\w$]*\s*\??\s*:/.test(segment)
}

/**
 * The objects a caller can reach the *global* `fetch`, `WebSocket` or
 * `EventSource` through.
 *
 * `globalThis.fetch(url)` is the same unmanaged call as `fetch(url)`, and it is
 * the form that survives a search for the bare one, so the gate has to see both
 * or an exception quietly stops matching the file it was written for. Any other
 * receiver is a caller's own field (`this.fetchImpl`, `deps.fetch`) and stays
 * out.
 */
const GLOBAL_RECEIVER = String.raw`(?:(?:globalThis|window|self)\s*\.\s*)?`

export function findFetchCalls(code) {
  const findings = []
  const pattern = new RegExp(String.raw`(^|[^\w$])${GLOBAL_RECEIVER}fetch\s*\(`, "g")
  let match
  while ((match = pattern.exec(code)) !== null) {
    const nameStart = match.index + match[1].length
    // A dot the alternation did not consume means some other object owns this
    // `fetch`, so it is not the global one.
    if (code[nameStart - 1] === ".") continue
    const before = code.slice(Math.max(0, nameStart - 24), nameStart)
    if (/\b(?:async|function)\s*$/.test(before)) continue

    const open = code.indexOf("(", nameStart)
    const close = matchParen(code, open)
    if (close === -1) continue
    // Only the FIRST top-level argument decides. Looking further would read
    // `fetch(url, { signal: x })` as a typed parameter list, because an object
    // literal's properties have exactly the shape of an annotation.
    if (isTypedParameter(firstTopLevelArgument(code.slice(open + 1, close)))) continue
    // `fetch(...) {` is a method body, not a call.
    if (/^\s*\{/.test(code.slice(close + 1))) continue

    findings.push({ index: nameStart, kind: "fetch" })
  }
  return findings
}

export function findConstructorCalls(code) {
  const findings = []
  for (const [kind, pattern] of [
    ["websocket", new RegExp(String.raw`new\s+${GLOBAL_RECEIVER}WebSocket\s*\(`, "g")],
    ["eventsource", new RegExp(String.raw`new\s+${GLOBAL_RECEIVER}EventSource\s*\(`, "g")],
  ]) {
    let match
    while ((match = pattern.exec(code)) !== null) {
      findings.push({ index: match.index, kind })
    }
  }
  return findings
}

export function findRustEgress(code) {
  const findings = []
  for (const [kind, pattern] of [
    ["reqwest-client-new", /reqwest::Client::new\s*\(\s*\)/g],
    ["no-proxy", /\.no_proxy\s*\(\s*\)/g],
  ]) {
    let match
    while ((match = pattern.exec(code)) !== null) {
      findings.push({ index: match.index, kind })
    }
  }
  return findings
}

/** Every unmanaged egress in the tree, as `{file, line, kind}`. */
export function collectFindings(
  readFile = (file) => readFileSync(resolve(REPO_ROOT, file), "utf8")
) {
  const findings = []
  for (const file of listFiles(TS_ROOTS, [".ts", ".tsx", ".mts", ".cts"])) {
    const code = blankNonCode(readFile(file))
    for (const hit of [...findFetchCalls(code), ...findConstructorCalls(code)]) {
      findings.push({ file, line: lineAt(code, hit.index), kind: hit.kind })
    }
  }
  for (const file of listFiles(RUST_ROOTS, [".rs"])) {
    const code = blankRustTestModules(blankNonCode(readFile(file)))
    for (const hit of findRustEgress(code)) {
      findings.push({ file, line: lineAt(code, hit.index), kind: hit.kind })
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return findings
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/** `file:kind` — deliberately NOT line-scoped, so an edit above a known
 * exception does not fail the build for an unrelated reason. Line drift is
 * noise; a NEW file or a NEW kind in an existing file is the signal. */
export function keyOf(finding) {
  return `${finding.file}::${finding.kind}`
}

export function validateAllowlist(allowlist) {
  const errors = []
  if (!Array.isArray(allowlist?.exceptions)) {
    return ["allowlist must have an `exceptions` array"]
  }
  const seen = new Set()
  for (const entry of allowlist.exceptions) {
    const label = `${entry?.file ?? "<no file>"}::${entry?.kind ?? "<no kind>"}`
    if (typeof entry?.file !== "string" || entry.file.length === 0) {
      errors.push(`${label}: \`file\` is required`)
      continue
    }
    // A wildcard exception stops being read and starts being a hole.
    if (/[*?]|\/$/.test(entry.file)) {
      errors.push(`${label}: wildcards and directory prefixes are not allowed — list each file`)
    }
    if (typeof entry?.kind !== "string") errors.push(`${label}: \`kind\` is required`)
    if (!REASONS.has(entry?.reason)) {
      errors.push(`${label}: \`reason\` must be one of ${[...REASONS].sort().join(", ")}`)
    }
    if (typeof entry?.note !== "string" || entry.note.trim().length < 12) {
      errors.push(`${label}: \`note\` must say why, in a sentence`)
    }
    const key = `${entry.file}::${entry.kind}`
    if (seen.has(key)) errors.push(`${label}: duplicate entry`)
    seen.add(key)
  }
  return errors
}

export function diffAgainstAllowlist(findings, allowlist) {
  const allowed = new Set(allowlist.exceptions.map((entry) => `${entry.file}::${entry.kind}`))
  const present = new Set(findings.map(keyOf))
  return {
    unlisted: findings.filter((finding) => !allowed.has(keyOf(finding))),
    stale: [...allowed].filter((key) => !present.has(key)).sort(),
  }
}

function buildBaseline(findings) {
  const byKey = new Map()
  for (const finding of findings) {
    const key = keyOf(finding)
    if (!byKey.has(key)) {
      byKey.set(key, {
        file: finding.file,
        kind: finding.kind,
        reason: "TODO",
        note: "TODO: explain why this egress cannot use a managed transport.",
      })
    }
  }
  return { exceptions: [...byKey.values()] }
}

function main() {
  const findings = collectFindings()

  if (process.argv.includes("--write-baseline")) {
    writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(buildBaseline(findings), null, 2)}\n`)
    console.log(
      `[network-egress] wrote ${buildBaseline(findings).exceptions.length} entries — ` +
        `replace every TODO reason/note before committing.`
    )
    return 0
  }

  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"))
  const shapeErrors = validateAllowlist(allowlist)
  if (shapeErrors.length > 0) {
    console.error(`[network-egress] ${shapeErrors.length} malformed allowlist entr(ies):`)
    for (const error of shapeErrors) console.error(`  - ${error}`)
    return 1
  }

  const { unlisted, stale } = diffAgainstAllowlist(findings, allowlist)

  if (unlisted.length > 0) {
    console.error(`[network-egress] ${unlisted.length} unmanaged egress site(s):`)
    for (const finding of unlisted) {
      console.error(`  ${finding.file}:${finding.line}  ${finding.kind}`)
    }
    console.error("")
    console.error("  Use a managed transport:")
    console.error("    TS   request/response  → proxyFetch / createPlatformFetch")
    console.error("    TS   SSE, NDJSON, big  → createPlatformStreamingFetch")
    console.error("    TS   WebSocket         → createPlatformWebSocket")
    console.error("    Rust                   → managed_client / apply_reqwest_policy")
    console.error("")
    console.error(
      "  If it genuinely cannot, add ONE entry per file to " +
        "scripts/gates/network-egress-allowlist.json with a reason and a note."
    )
    return 1
  }

  if (stale.length > 0) {
    console.error(`[network-egress] ${stale.length} allowlist entr(ies) match nothing any more:`)
    for (const key of stale) console.error(`  ${key}`)
    console.error("")
    console.error(
      "  Delete them. A stale exception silently re-opens the next bare call written in that file."
    )
    return 1
  }

  console.log(
    `[network-egress] OK: ${findings.length} egress site(s), all ` +
      `${allowlist.exceptions.length} exception(s) accounted for.`
  )
  return 0
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirectRun) process.exit(main())
