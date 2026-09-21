#!/usr/bin/env node
/**
 * LLM ledger boundary gate (ADR-0188 D27).
 *
 * D27 says every LLM generation is reserved before it leaves and settled when it
 * comes back, through the Router + Fusion CallLedger, whenever its surface is on
 * (`chat`, `utilityLedger`, `agentsWorkflows`, …). That holds only while every
 * direct generation call sits behind one of the ledgered seams:
 *
 *   - renderer utilities: `lib/ai/renderer-llm-client.ts` → `ledgerUtilityCalls`
 *     (`lib/router-fusion/gate/utility-ledger.ts`) → `lib/router-fusion/calls/*`;
 *   - workflow `ai.prompt`: the same wrapper, on `agentsWorkflows`;
 *   - the sidecar: `sidecar/dispatch/call-ledger-gate.mjs`, engaged by the
 *     `SendOptions.ledger` stamp of a routed chat turn;
 *   - Router + Fusion's own role calls (`lib/router-fusion/calls/*`).
 *
 * This gate finds every production file that makes a direct generation call and
 * holds each one to a reviewed row in `llm-ledger-boundary-baseline.json`. A new
 * file, or a new kind of call in a listed file, fails. A row whose file no longer
 * makes the calls it lists fails too: the baseline may only shrink.
 *
 * ## What counts as a direct generation call ("entry")
 *
 *   ai:<api>               `generateText` / `streamText` / `generateObject` /
 *                          `streamObject` loaded at runtime from `ai`
 *   provider-sdk:<module>  any runtime import of a provider's own SDK
 *                          (`@anthropic-ai/sdk`, `openai`, `@google/genai`, …)
 *   agent-sdk:<fn>         `query` / `startup` from the Claude Agent SDK
 *   llm-client:<factory>   the repo's raw client factory (`createLlmClient`, alias
 *                          `createAnthropicLlmClient`, from `lib/twin/distill/llm`
 *                          or its barrel). An `LlmClient` hides its model call
 *                          behind `client.complete()`, so building one is the
 *                          only point a scan can see; it stays unledgered until
 *                          the caller wraps it with `ledgerUtilityCalls`. (A bare
 *                          `LanguageModel` is not tracked: the file that calls
 *                          `generateText` on it is.)
 *   language-model:<m>     `.doGenerate(` / `.doStream(` on an AI SDK model
 *   endpoint:<kind>        a string literal naming a generation HTTP endpoint
 *                          (`/chat/completions`, `/v1/messages`, `/v1/responses`,
 *                          `:generateContent`, Ollama `/api/generate|chat`)
 *
 * Type-only imports, comments and string contents never count.
 *
 * ## Out of scope (the D27 boundary)
 *
 * Embeddings (`embed`, `embedMany`), speech (TTS / transcription), OCR, rerank
 * and media generation (`generateImage`, `experimental_generateVideo`) keep the
 * post-hoc usage ledger. Their AI SDK APIs are not scanned. A raw HTTP endpoint
 * an OCR or TTS provider happens to share with chat (`/v1/messages`,
 * `:generateContent`) is still found, and is listed with reason
 * `d27-out-of-scope` so a new one is reviewed rather than silently absorbed.
 *
 * ## Reasons (fixed vocabulary)
 *
 * See `REASONS` below. `ledgered-entry` is a claim, so it is checked: the file
 * must reference a ledger seam, or the row is an error. A file whose calls are
 * reserved by its caller (the sidecar AI SDK adapter, reserved per leg by
 * `sidecar/dispatch/ai-sdk.mjs`) names that caller in `seam`, and the check runs
 * there instead.
 *
 * ## What a static scan cannot see
 *
 *   - A sidecar dispatch file is ledgered only for a send that carries the
 *     `SendOptions.ledger` stamp. Whether a sender stamps is decided upstream
 *     (`lib/claude/build-options.ts`), outside any file this gate reads.
 *   - A plugin protocol adapter that `fetch`es a URL built at runtime
 *     (`sidecar/dispatch/protocol-adapters/{openai-compatible-variant,code}-adapter.mjs`)
 *     names no endpoint literal. Both are reached only through `ai-sdk.mjs`
 *     (ledgered legs) and `feature-call.mjs` (listed on its own row).
 *   - The Rust gateway's upstream calls are the gateway passthrough ledger's
 *     business (`gatewayPassthroughLedger`), not this TypeScript scan's.
 *
 * Tests, stories, fixtures, declaration files, generated code and build output
 * are not scanned.
 *
 * Usage:
 *   pnpm audit:llm-ledger-boundary
 *   node scripts/gates/check-llm-ledger-boundary.mjs [--root <dir>] [--baseline <file>]
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, posix, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const BASELINE = resolve(ROOT, "scripts/gates/llm-ledger-boundary-baseline.json")

/** Where production code that can reach a model lives. `packages` means `packages/<name>/src`. */
export const SCAN_ROOTS = [
  "lib",
  "components",
  "hooks",
  "stores",
  "app",
  "plugins",
  "cli/src",
  "sidecar",
  "packages",
]

/** AI SDK text generation. Embedding, speech, image/video and rerank APIs are out of scope (D27). */
export const GENERATION_APIS = ["generateText", "streamText", "generateObject", "streamObject"]

/** Provider-owned SDKs. Any runtime import of one is a direct client. */
export const PROVIDER_SDK_MODULES = [
  "@anthropic-ai/sdk",
  "@anthropic-ai/bedrock-sdk",
  "@anthropic-ai/vertex-sdk",
  "openai",
  "@google/genai",
  "@google/generative-ai",
  "@mistralai/mistralai",
  "cohere-ai",
  "groq-sdk",
  "ollama",
  "together-ai",
]

/** The Claude Agent SDK (and its former package name) and the calls that start a model loop. */
export const AGENT_SDK_MODULES = ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-code"]
export const AGENT_SDK_ENTRIES = ["query", "startup"]

/**
 * The repo's raw `LlmClient` factory, under both of its names, and the modules
 * that export it (the file itself and the `lib/twin/distill` barrel). A file
 * that re-exports the factory is itself flagged; add its path here so its
 * consumers are tracked too.
 */
export const LLM_CLIENT_MODULES = ["lib/twin/distill/llm", "lib/twin/distill"]
export const LLM_CLIENT_FACTORIES = ["createLlmClient", "createAnthropicLlmClient"]

/** Direct calls on an AI SDK `LanguageModel`, below `generateText` / `streamText`. */
export const LANGUAGE_MODEL_METHODS = ["doGenerate", "doStream"]

/** Generation HTTP endpoints, matched against the static pieces of string and template literals. */
export const GENERATION_ENDPOINTS = [
  { kind: "chat-completions", re: /\/chat\/completions(?=$|[?#])/ },
  // Lark's IM API is `/im/v1/messages`; that is a chat platform, not a model.
  { kind: "anthropic-messages", re: /(?<!\/im)\/v1\/messages(?=$|[?#])/ },
  { kind: "responses", re: /\/v1\/responses(?=$|[?#])/ },
  { kind: "gemini-generate-content", re: /:(?:stream)?[gG]enerateContent(?=$|[?#])/ },
  { kind: "ollama-generate", re: /\/api\/generate(?=$|[?#])/ },
  { kind: "ollama-chat", re: /\/api\/chat(?=$|[?#])/ },
]

/**
 * Why a file may make direct generation calls. Fixed vocabulary — a free-text
 * reason degrades into "because it was there".
 */
export const REASONS = {
  "ledgered-entry":
    "Every call reaches the CallLedger (utility-ledger wrapper, sidecar call-ledger gate, or a Router + Fusion role call) whenever its surface is on.",
  unwrapped:
    "Makes generation calls the ledger never sees, even with every surface on. A WP-H4 follow-up: wrap it or document a named exemption.",
  "client-factory":
    "Builds a raw client and calls nothing itself; every consumer is scanned and listed on its own row.",
  "d27-out-of-scope":
    "An embedding, speech or OCR call that shares an endpoint with chat; it keeps the post-hoc usage ledger (D27 boundary).",
  "not-a-provider-call":
    "Names an endpoint or entry without sending a model request: a fake or replay server, a keyword table, a URL placeholder.",
}

/** What a `ledgered-entry` file must reference for the claim to be believable. */
export const LEDGER_SEAM_MARKERS = [
  /\bledgerUtilityCalls\b/,
  /\bcreateCallLedgerGate\b/,
  /call-ledger-gate/,
  /\bledgerGate\b/,
]

const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/
const EXEMPT_FILE =
  /\.d\.[cm]?ts$|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|\.generated\.[cm]?[jt]sx?$/
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "generated",
  "fixtures",
  "tests",
  "__tests__",
  "__mocks__",
  "__fixtures__",
])

/** Cheap pre-filter: a file that contains none of these cannot produce an entry. */
const TRIGGERS = [
  `"ai"`,
  `'ai'`,
  ...PROVIDER_SDK_MODULES.flatMap((m) => [`"${m}`, `'${m}`]),
  "claude-agent-sdk",
  "claude-code",
  ...LLM_CLIENT_FACTORIES,
  ...LANGUAGE_MODEL_METHODS,
  "completions",
  "/v1/messages",
  "/v1/responses",
  "enerateContent",
  "/api/generate",
  "/api/chat",
]

// ── Lexing ──────────────────────────────────────────────────────────────────

const REGEX_PRECEDERS = new Set([..."(,=:[!&|?{};+-*%<>~^"])
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
])

const blankOf = (text) => text.replace(/[^\n]/g, " ")

/**
 * Split a JS/TS source into:
 *   - `code`: the source with comments blanked (strings kept), for import parsing;
 *   - `bare`: `code` with string, template and regex contents blanked too, for
 *     identifier and call checks;
 *   - `strings`: the static text of every string literal and template chunk.
 *
 * Offsets are preserved (every blanked character becomes a space; newlines stay).
 * The regex-literal test is the usual previous-token heuristic; JSX text with an
 * apostrophe is treated as a string that ends at the line break, which bounds the
 * damage to that line.
 */
export function lexSource(source) {
  const code = []
  const bare = []
  const strings = []
  /** One brace depth per open `${` of an enclosing template literal. */
  const templateDepths = []
  let last = ""
  let i = 0
  const n = source.length

  const keep = (text) => {
    code.push(text)
    bare.push(text)
  }
  const literal = (text) => {
    code.push(text)
    bare.push(blankOf(text))
  }

  /** Scan template text from `start`; stops after the closing backtick or after `${`. */
  const scanTemplate = (start) => {
    let j = start
    while (j < n) {
      const ch = source[j]
      if (ch === "\\") {
        j += 2
        continue
      }
      if (ch === "`") {
        strings.push(source.slice(start, j))
        literal(source.slice(start, j + 1))
        return { end: j + 1, closed: true }
      }
      if (ch === "$" && source[j + 1] === "{") {
        strings.push(source.slice(start, j))
        literal(source.slice(start, j + 2))
        return { end: j + 2, closed: false }
      }
      j += 1
    }
    strings.push(source.slice(start))
    literal(source.slice(start))
    return { end: n, closed: true }
  }

  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]

    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i)
      const stop = end === -1 ? n : end
      const text = source.slice(i, stop)
      code.push(blankOf(text))
      bare.push(blankOf(text))
      i = stop
      continue
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      const stop = end === -1 ? n : end + 2
      const text = source.slice(i, stop)
      code.push(blankOf(text))
      bare.push(blankOf(text))
      i = stop
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < n && source[j] !== ch && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1
      const stop = Math.min(n, source[j] === ch ? j + 1 : j)
      strings.push(source.slice(i + 1, source[j] === ch ? j : stop))
      code.push(source.slice(i, stop))
      bare.push(ch + blankOf(source.slice(i + 1, stop - 1)) + (source[j] === ch ? ch : " "))
      i = stop
      last = "literal"
      continue
    }
    if (ch === "`") {
      keep("`")
      const scanned = scanTemplate(i + 1)
      if (!scanned.closed) templateDepths.push(0)
      i = scanned.end
      last = "literal"
      continue
    }
    if (ch === "/" && (last === "" || REGEX_PRECEDERS.has(last) || REGEX_KEYWORDS.has(last))) {
      let j = i + 1
      let inClass = false
      let ok = false
      while (j < n && source[j] !== "\n") {
        const c = source[j]
        if (c === "\\") {
          j += 2
          continue
        }
        if (c === "[") inClass = true
        else if (c === "]") inClass = false
        else if (c === "/" && !inClass) {
          ok = true
          break
        }
        j += 1
      }
      if (ok) {
        let stop = j + 1
        while (stop < n && /[a-z]/i.test(source[stop])) stop += 1
        literal(source.slice(i, stop))
        i = stop
        last = "literal"
        continue
      }
    }
    if (templateDepths.length > 0) {
      if (ch === "{") templateDepths[templateDepths.length - 1] += 1
      else if (ch === "}") {
        if (templateDepths[templateDepths.length - 1] === 0) {
          templateDepths.pop()
          keep("}")
          const scanned = scanTemplate(i + 1)
          if (!scanned.closed) templateDepths.push(0)
          i = scanned.end
          last = "literal"
          continue
        }
        templateDepths[templateDepths.length - 1] -= 1
      }
    }
    if (/[\w$]/.test(ch)) {
      let j = i + 1
      while (j < n && /[\w$]/.test(source[j])) j += 1
      const word = source.slice(i, j)
      keep(word)
      last = word
      i = j
      continue
    }
    keep(ch)
    if (!/\s/.test(ch)) last = ch
    i += 1
  }
  return { code: code.join(""), bare: bare.join(""), strings }
}

// ── Import resolution ───────────────────────────────────────────────────────

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
const STATIC_RE =
  /(?:^|[\n;])[ \t]*(import|export)\s+(type\s+)?([\w*${}\s,]*?)\s*from\s*["']([^"'\n]+)["']/g
const SIDE_EFFECT_RE = /(?:^|[\n;])[ \t]*import\s*["']([^"'\n]+)["']/g
const LOADER_RE = /\b(import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g

/** `{ a, b as c, type D }` → [{ imported: "a", local: "a" }, { imported: "b", local: "c" }]. */
function namedBindings(list) {
  return list
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("type "))
    .map((part) => {
      const [imported, local] = part.split(/\s+as\s+/).map((s) => s.trim())
      return { imported, local: local ?? imported }
    })
    .filter((binding) => /^[\w$]+$/.test(binding.imported))
}

/** Destructuring pattern `{ a, b: c }` → imported names. */
function destructuredNames(list) {
  return list
    .split(",")
    .map((part) => part.trim().split(":")[0].trim().replace(/=.*$/, "").trim())
    .filter((name) => /^[\w$]+$/.test(name))
}

/** Normalize a specifier to a repo-relative path (for `@/` and relative ones), else null. */
export function repoPathOf(specifier, fromRel) {
  let target
  if (specifier.startsWith("@/")) target = specifier.slice(2)
  else if (specifier.startsWith("."))
    target = posix.normalize(posix.join(posix.dirname(fromRel), specifier))
  else return null
  return target.replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/, "").replace(/\/index$/, "")
}

/**
 * How a file loads one module at runtime.
 *
 * Returns `null` when it never does. Otherwise `{ names, opaque }`: the exported
 * names it takes, and whether some load binds the module in a way those names
 * cannot be read from (then callers fall back to an identifier scan).
 */
export function moduleUse(lexed, matches) {
  const { code, bare } = lexed
  const names = new Set()
  let loaded = false
  let opaque = false

  const trackNamespace = (local) => {
    const re = new RegExp(`(?<![\\w$.])${escapeRe(local)}\\s*(?:\\.\\s*([\\w$]+)|\\[)`, "g")
    for (const match of bare.matchAll(re)) {
      if (match[1]) names.add(match[1])
      else opaque = true
    }
  }

  for (const match of code.matchAll(STATIC_RE)) {
    const [, keyword, typeOnly, clause, specifier] = match
    if (typeOnly || !matches(specifier)) continue
    const braces = clause.match(/\{([^}]*)\}/)
    const outside = clause
      .replace(/\{[^}]*\}/, "")
      .replace(/,/g, " ")
      .trim()
    const bindings = braces ? namedBindings(braces[1]) : []
    if (keyword === "export" && /^\*/.test(outside)) {
      loaded = true
      opaque = true
      continue
    }
    if (bindings.length === 0 && !outside) continue // every binding is `type X`
    loaded = true
    for (const binding of bindings) names.add(binding.imported)
    const namespace = outside.match(/\*\s*as\s+([\w$]+)/)
    if (namespace) trackNamespace(namespace[1])
    else if (outside && keyword === "import") {
      // A default import: the module object for CommonJS-style packages.
      trackNamespace(outside.split(/\s+/)[0])
      names.add("default")
    }
  }

  for (const match of code.matchAll(SIDE_EFFECT_RE)) {
    if (matches(match[1])) loaded = true
  }

  for (const match of code.matchAll(LOADER_RE)) {
    const [whole, loader, specifier] = match
    if (!matches(specifier)) continue
    const before = code.slice(Math.max(0, match.index - 200), match.index)
    const after = code.slice(match.index + whole.length, match.index + whole.length + 200)
    // `typeof import("x")` and `import("x").Type` are type positions.
    if (/\btypeof\s*$/.test(before)) continue
    const member = after.match(/^\s*\.\s*([\w$]+)/)
    if (loader === "import" && member && member[1] !== "then") continue
    loaded = true
    const wrapped = after.match(/^\s*\)\s*\.\s*([\w$]+)/) // (await import("x")).name
    const destructured = before.match(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s*)?\(?\s*$/)
    const bound = before.match(/(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:await\s*)?\(?\s*$/)
    const then = after.match(/^\s*\.then\s*\(\s*(?:async\s*)?\(?\s*(\{[^}]*\}|[\w$]+)/)
    if (loader === "require" && member) names.add(member[1])
    else if (wrapped) names.add(wrapped[1])
    else if (destructured) for (const name of destructuredNames(destructured[1])) names.add(name)
    else if (bound) trackNamespace(bound[1])
    else if (then) {
      if (then[1].startsWith("{")) {
        for (const name of destructuredNames(then[1].slice(1, -1))) names.add(name)
      } else trackNamespace(then[1])
    } else opaque = true
  }

  return loaded ? { names, opaque } : null
}

/** Names from `wanted` a module is used for, falling back to identifiers when the binding is opaque. */
function usedEntries(lexed, use, wanted) {
  if (!use) return []
  const found = wanted.filter((name) => use.names.has(name))
  if (use.opaque) {
    for (const name of wanted) {
      if (!found.includes(name) && new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(lexed.bare))
        found.push(name)
    }
  }
  return found
}

// ── Detection ───────────────────────────────────────────────────────────────

/** Every direct generation entry of one production file, sorted. */
export function detectEntries(file, source) {
  if (!TRIGGERS.some((trigger) => source.includes(trigger))) return []
  const lexed = lexSource(source)
  const entries = new Set()

  const ai = moduleUse(lexed, (specifier) => specifier === "ai")
  for (const api of usedEntries(lexed, ai, GENERATION_APIS)) entries.add(`ai:${api}`)

  for (const pkg of PROVIDER_SDK_MODULES) {
    const use = moduleUse(
      lexed,
      (specifier) => specifier === pkg || specifier.startsWith(`${pkg}/`)
    )
    if (use) entries.add(`provider-sdk:${pkg}`)
  }

  const agentSdk = moduleUse(lexed, (specifier) =>
    AGENT_SDK_MODULES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))
  )
  for (const fn of usedEntries(lexed, agentSdk, AGENT_SDK_ENTRIES)) entries.add(`agent-sdk:${fn}`)

  const factory = moduleUse(lexed, (specifier) =>
    LLM_CLIENT_MODULES.includes(repoPathOf(specifier, file))
  )
  for (const fn of usedEntries(lexed, factory, LLM_CLIENT_FACTORIES))
    entries.add(`llm-client:${fn}`)

  for (const method of LANGUAGE_MODEL_METHODS) {
    if (new RegExp(`\\.\\s*${method}\\s*\\(`).test(lexed.bare))
      entries.add(`language-model:${method}`)
  }

  for (const text of lexed.strings) {
    for (const endpoint of GENERATION_ENDPOINTS) {
      if (endpoint.re.test(text)) entries.add(`endpoint:${endpoint.kind}`)
    }
  }

  return [...entries].sort()
}

/** Does the file reference a ledger seam (checked for every `ledgered-entry` row)? */
export function hasLedgerSeam(file, source) {
  if (file.startsWith("lib/router-fusion/")) return true
  const { bare, code } = lexSource(source)
  return (
    LEDGER_SEAM_MARKERS.some((marker) => marker.test(bare)) ||
    /["'][^"']*(?:router-fusion\/gate\/utility-ledger|call-ledger-gate)[^"']*["']/.test(code)
  )
}

// ── Files ───────────────────────────────────────────────────────────────────

export function isScannedFile(rel) {
  if (!SOURCE_FILE.test(rel) || EXEMPT_FILE.test(rel)) return false
  const parts = rel.split("/")
  if (parts[0] === "packages" && parts[2] !== "src") return false
  return !parts.slice(0, -1).some((part) => SKIPPED_DIRS.has(part) || part.startsWith("."))
}

function walk(root, dir, out) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || SKIPPED_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(root, full, out)
    else {
      const rel = relative(root, full).split("\\").join("/")
      if (isScannedFile(rel)) out.push(rel)
    }
  }
}

export function productionFiles(root = ROOT) {
  const files = []
  for (const scanRoot of SCAN_ROOTS) walk(root, join(root, scanRoot), files)
  return files.sort()
}

/** Every scanned file with at least one entry: `{ file → entries[] }`. */
export function scanTree(root = ROOT) {
  const files = productionFiles(root)
  const found = {}
  for (const file of files) {
    const entries = detectEntries(file, readFileSync(join(root, file), "utf8"))
    if (entries.length > 0) found[file] = entries
  }
  return { files, found }
}

// ── Baseline ────────────────────────────────────────────────────────────────

export function loadBaseline(path = BASELINE) {
  if (!existsSync(path)) throw new Error(`Missing LLM ledger boundary baseline: ${path}`)
  const value = JSON.parse(readFileSync(path, "utf8"))
  const rows = value?.files
  if (!rows || typeof rows !== "object" || Array.isArray(rows))
    throw new Error("LLM ledger boundary baseline must be { files: { <path>: row } }")
  const errors = []
  for (const [file, row] of Object.entries(rows)) {
    if (!Object.hasOwn(REASONS, row?.reason))
      errors.push(`${file}: reason must be one of ${Object.keys(REASONS).join(", ")}`)
    if (typeof row?.note !== "string" || !row.note.trim()) errors.push(`${file}: note is required`)
    if (row?.seam !== undefined) {
      if (row.reason !== "ledgered-entry")
        errors.push(`${file}: seam is only for ledgered-entry rows`)
      else if (typeof row.seam !== "string" || !row.seam.trim() || row.seam === file)
        errors.push(`${file}: seam must name the other file that reserves this file's calls`)
    }
    if (
      !Array.isArray(row?.entries) ||
      row.entries.length === 0 ||
      row.entries.some((entry) => typeof entry !== "string" || !entry)
    )
      errors.push(`${file}: entries must be a non-empty list of entry ids`)
    else if (new Set(row.entries).size !== row.entries.length)
      errors.push(`${file}: entries repeat`)
  }
  if (errors.length > 0)
    throw new Error(`Invalid LLM ledger boundary baseline:\n  ${errors.join("\n  ")}`)
  return rows
}

/**
 * Compare a scan with the baseline.
 *
 *   unlisted  — a file (or an entry of a listed file) the baseline does not name;
 *   stale     — a row naming an entry the file no longer has (remove it);
 *   unproven  — a `ledgered-entry` row whose seam file (the row's `seam`, else the
 *               file itself) references no ledger seam, or no longer exists.
 *
 * `readSource(file)` returns the file's text, or null when it does not exist.
 */
export function compare(found, baseline, readSource) {
  const unlisted = []
  const stale = []
  const unproven = []
  for (const [file, entries] of Object.entries(found)) {
    const row = baseline[file]
    const missing = row ? entries.filter((entry) => !row.entries.includes(entry)) : entries
    if (missing.length > 0) unlisted.push({ file, entries: missing })
  }
  for (const [file, row] of Object.entries(baseline)) {
    const present = found[file] ?? []
    const gone = row.entries.filter((entry) => !present.includes(entry))
    if (gone.length > 0) stale.push({ file, entries: gone })
    if (row.reason === "ledgered-entry" && present.length > 0) {
      const seamFile = row.seam ?? file
      const source = readSource(seamFile)
      if (source === null || !hasLedgerSeam(seamFile, source))
        unproven.push({ file, seam: seamFile })
    }
  }
  const byFile = (a, b) => a.file.localeCompare(b.file)
  return {
    unlisted: unlisted.sort(byFile),
    stale: stale.sort(byFile),
    unproven: unproven.sort(byFile),
  }
}

export function runAudit(root = ROOT, baselinePath = BASELINE) {
  const baseline = loadBaseline(baselinePath)
  const { files, found } = scanTree(root)
  const result = compare(found, baseline, (file) => {
    const path = join(root, file)
    return existsSync(path) ? readFileSync(path, "utf8") : null
  })
  return { files, found, baseline, ...result }
}

/** `--root <dir>` and `--baseline <file>` point the audit elsewhere (fixtures, debugging). */
export function parseArgs(argv) {
  const args = { root: ROOT, baseline: BASELINE }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag !== "--root" && flag !== "--baseline") throw new Error(`Unknown argument: ${flag}`)
    const value = argv[i + 1]
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`)
    args[flag.slice(2)] = resolve(value)
    i += 1
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const { files, baseline, unlisted, stale, unproven } = runAudit(args.root, args.baseline)
  if (stale.length > 0) {
    console.error(
      `[llm-ledger-boundary] ${stale.length} stale baseline row(s) (the list may only shrink):`
    )
    for (const row of stale) console.error(`  ${row.file} -> ${row.entries.join(", ")}`)
    console.error("Remove the entries (or the whole row) the file no longer has.")
  }
  if (unproven.length > 0) {
    console.error(
      `[llm-ledger-boundary] ${unproven.length} ledgered-entry row(s) with no ledger seam in the file:`
    )
    for (const row of unproven)
      console.error(row.seam === row.file ? `  ${row.file}` : `  ${row.file} (seam: ${row.seam})`)
    console.error(
      "Wrap the calls with ledgerUtilityCalls / the sidecar call-ledger gate, or relabel the row."
    )
  }
  if (unlisted.length > 0) {
    console.error(
      `[llm-ledger-boundary] ${unlisted.length} file(s) with unreviewed direct LLM generation calls:`
    )
    for (const row of unlisted) console.error(`  ${row.file} -> ${row.entries.join(", ")}`)
    console.error(
      "Route the call through a ledgered seam (buildRendererLlmClient / ledgerUtilityCalls, or the sidecar " +
        "dispatch), or add a reviewed row to scripts/gates/llm-ledger-boundary-baseline.json."
    )
  }
  if (stale.length > 0 || unproven.length > 0 || unlisted.length > 0) return 1
  const count = (reason) => Object.values(baseline).filter((row) => row.reason === reason).length
  const exempt = Object.keys(baseline).length - count("ledgered-entry") - count("unwrapped")
  console.log(
    `[llm-ledger-boundary] OK: ${files.length} production files scanned; ` +
      `${Object.keys(baseline).length} reviewed file(s): ${count("ledgered-entry")} ledgered-entry, ` +
      `${count("unwrapped")} unwrapped, ${exempt} exempt.`
  )
  return 0
}

const direct =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (direct) process.exit(main())
