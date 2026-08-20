/**
 * Paste-in / copy-out for MCP server definitions.
 *
 * Two directions, one vocabulary:
 *
 * - **In** — `parseMcpTransferInput` takes whatever the user pasted (a
 *   `claude mcp add …` line from a README, a `codex mcp add … -- npx …`, a
 *   bare `npx -y @scope/server`, or a `{"mcpServers": {…}}` block) and returns
 *   normalized drafts. Every published MCP server documents itself as one of
 *   those four shapes, so retyping them into a form is pure friction.
 * - **Out** — `buildMcpInstallCommand` / `buildMcpTransferJson` turn a
 *   configured server back into the command or JSON another agent accepts,
 *   which is how a user moves a working server to a machine Cognia does not
 *   run on.
 *
 * Reuse, not reimplementation: JSON entries go through
 * `normalizeMcpEntry`/`denormalizeMcpEntry` (the same normalizer every agent
 * adapter uses), and agent-shaped JSON export delegates to the adapter's own
 * `project()`. This module owns exactly one thing nothing else did: shell
 * tokenizing and the CLI flag grammars.
 *
 * Pure — no Dexie, no Tauri — so the settings dialog, the tests, and any
 * future CLI subcommand share one implementation.
 */

import type { AgentId, McpTransport } from "@cognia/agent-config-types"
import { MCP_AGENT_ADAPTERS } from "@/lib/claude/agents"
import { denormalizeMcpEntry, normalizeMcpEntry } from "@/lib/claude/agents/shared"

export interface McpTransferDraft {
  name: string
  transport: McpTransport
  config: Record<string, unknown>
}

export type McpTransferKind = "command" | "json" | "empty"

export interface McpTransferParse {
  kind: McpTransferKind
  drafts: McpTransferDraft[]
  /** Non-fatal notes: guessed names, dropped flags, skipped entries. */
  warnings: McpTransferWarning[]
  /** Set when nothing could be parsed. Machine-readable, not user-facing. */
  error?: McpTransferErrorCode
}

export type McpTransferErrorCode =
  "empty" | "invalid-json" | "no-entries" | "unrecognized" | "missing-target"

export type McpTransferWarning =
  | { code: "guessed-name"; name: string }
  | { code: "ignored-flag"; flag: string }
  | { code: "skipped-entry"; name: string }
  | { code: "renamed"; from: string; to: string }

/** Namespace charset accepted by `validateMcpDefinition`. */
const NAME_ALLOWED = /[^A-Za-z0-9_.-]+/g

/** Binaries whose `mcp add` grammar we understand. */
const AGENT_BINARIES = new Set([
  "claude",
  "codex",
  "gemini",
  "cursor-agent",
  "windsurf",
  "opencode",
  "qwen",
  "crush",
  "amp",
  "goose",
  "cognia",
])

/** Runners that are never the server's identity — never guess a name from one. */
const RUNNER_TOKENS = new Set([
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bunx",
  "bun",
  "uv",
  "uvx",
  "pipx",
  "python",
  "python3",
  "node",
  "deno",
  "docker",
  "podman",
  "sh",
  "bash",
  "cmd",
  "cmd.exe",
  "run",
  "-y",
  "--yes",
  "-i",
  "--rm",
  "exec",
  "tool",
])

/**
 * Split a shell command into argv, honouring single quotes (fully literal),
 * double quotes (backslash escapes), bare backslash escapes, and `\`-newline
 * continuations. Returns null only for input that closes no quote — a paste
 * that lost half a line.
 */
export function tokenizeShellCommand(input: string): string[] | null {
  const text = input.replace(/\\\r?\n/g, " ").replace(/\r/g, "")
  const tokens: string[] = []
  let current = ""
  let started = false
  let quote: '"' | "'" | null = null

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) {
        current += text[i + 1]
        i += 1
      } else if (char === '"') {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === "\\" && i + 1 < text.length) {
      current += text[i + 1]
      started = true
      i += 1
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (quote) return null
  if (started) tokens.push(current)
  return tokens
}

/** Strip copy-paste chrome: a leading `$`/`>` prompt and surrounding fences. */
function stripPromptChrome(input: string): string {
  return input
    .trim()
    .replace(/^```[a-zA-Z]*\r?\n?/, "")
    .replace(/```$/, "")
    .trim()
    .replace(/^[$>#]\s+/, "")
    .trim()
}

/** Coerce any user-supplied label into a valid MCP namespace. */
export function sanitizeMcpName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(NAME_ALLOWED, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128)
  return cleaned
}

/**
 * Best-effort name for a command that never named itself. Prefers the last
 * token that looks like a package/image over the runner that launched it, so
 * `npx -y @modelcontextprotocol/server-filesystem /tmp` becomes
 * `server-filesystem`, not `npx`.
 */
export function guessServerName(command: string, args: readonly string[]): string {
  const candidates = [...args].reverse()
  for (const arg of candidates) {
    if (arg.startsWith("-")) continue
    if (RUNNER_TOKENS.has(arg)) continue
    // Paths and plain values aren't identities; package specs and images are.
    const looksLikePackage = /^@?[\w.-]+\/[\w.-]+$/.test(arg) || /^[\w.-]*mcp[\w.-]*$/i.test(arg)
    if (!looksLikePackage) continue
    const tail = arg.split("/").pop() ?? arg
    const name = sanitizeMcpName(tail.replace(/@[\d.^~><=*-]+$/, ""))
    if (name) return name
  }
  const fallback = sanitizeMcpName((command.split(/[\\/]/).pop() ?? command).replace(/\.\w+$/, ""))
  return fallback || "mcp-server"
}

/** Fold `streamable-http` and other vendor spellings onto our three. */
function coerceTransport(value: string): McpTransport | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === "streamable-http" || normalized === "streamablehttp") return "http"
  if (normalized === "stdio" || normalized === "sse" || normalized === "http") return normalized
  return null
}

interface FlagState {
  transport: McpTransport | null
  env: Record<string, string>
  headers: Record<string, string>
  url: string | null
  name: string | null
  cwd: string | null
  positional: string[]
  /** Everything after a bare `--`, which is always the child command. */
  rest: string[]
  warnings: McpTransferWarning[]
  json: string | null
}

/** Flags that take a value we deliberately drop (scope, project selection…). */
const IGNORED_VALUE_FLAGS = new Set([
  "-s",
  "--scope",
  "--project",
  "--config",
  "-p",
  "--profile",
  "--description",
])
const IGNORED_BOOLEAN_FLAGS = new Set(["--force", "-f", "--yes", "-y", "--global", "--user"])

function splitKeyValue(raw: string, separator: RegExp): [string, string] | null {
  const match = raw.match(separator)
  if (!match || match.index === undefined) return null
  const key = raw.slice(0, match.index).trim()
  const value = raw.slice(match.index + match[0].length).trim()
  if (!key) return null
  return [key, value]
}

function parseFlags(tokens: readonly string[]): FlagState {
  const state: FlagState = {
    transport: null,
    env: {},
    headers: {},
    url: null,
    name: null,
    cwd: null,
    positional: [],
    rest: [],
    warnings: [],
    json: null,
  }

  let sawSeparator = false
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (sawSeparator) {
      state.rest.push(token)
      continue
    }
    if (token === "--") {
      sawSeparator = true
      continue
    }

    const take = (): string | null => {
      const inline = token.includes("=") ? token.slice(token.indexOf("=") + 1) : null
      if (inline !== null) return inline
      const next = tokens[i + 1]
      if (next === undefined) return null
      i += 1
      return next
    }
    const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token

    if (!token.startsWith("-")) {
      state.positional.push(token)
      continue
    }

    if (flag === "-t" || flag === "--transport" || flag === "--type") {
      const value = take()
      const transport = value ? coerceTransport(value) : null
      if (transport) state.transport = transport
      continue
    }
    if (flag === "-e" || flag === "--env") {
      const value = take()
      const pair = value ? splitKeyValue(value, /=/) : null
      if (pair) state.env[pair[0]] = pair[1]
      continue
    }
    if (flag === "-H" || flag === "--header") {
      const value = take()
      const pair = value ? splitKeyValue(value, /:\s*|=/) : null
      if (pair) state.headers[pair[0]] = pair[1]
      continue
    }
    if (flag === "--url") {
      state.url = take()
      continue
    }
    if (flag === "--name") {
      state.name = take()
      continue
    }
    if (flag === "--cwd" || flag === "--directory") {
      state.cwd = take()
      continue
    }
    if (flag === "--add-mcp" || flag === "--json") {
      state.json = take()
      continue
    }
    if (IGNORED_VALUE_FLAGS.has(flag)) {
      take()
      state.warnings.push({ code: "ignored-flag", flag })
      continue
    }
    if (IGNORED_BOOLEAN_FLAGS.has(flag)) {
      state.warnings.push({ code: "ignored-flag", flag })
      continue
    }
    // Unknown flag: assume it takes no value rather than swallowing the next
    // positional, which would lose the command.
    state.warnings.push({ code: "ignored-flag", flag })
  }

  return state
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function draftFromFlags(state: FlagState): McpTransferParse | null {
  const warnings = [...state.warnings]
  const positional = [...state.positional]

  // `<bin> mcp add-json <name> '<json>'`
  if (state.json) {
    const parsed = parseMcpConfigJson(state.json, positional[0])
    return { ...parsed, warnings: [...warnings, ...parsed.warnings] }
  }

  let name = state.name ?? null
  let url = state.url ?? null
  let command: string | null = null
  let args: string[] = []

  // Grammar across every CLI we accept: the first positional is the server
  // name UNLESS it is already a URL or the only token (a bare command line).
  if (
    positional.length > 0 &&
    !looksLikeUrl(positional[0]) &&
    (name === null || positional.length > 1)
  ) {
    if (state.rest.length > 0 || positional.length > 1 || url !== null) {
      name = name ?? positional.shift() ?? null
    }
  }

  if (state.rest.length > 0) {
    command = state.rest[0] ?? null
    args = state.rest.slice(1)
  } else if (positional.length > 0) {
    if (looksLikeUrl(positional[0])) {
      url = url ?? positional[0]
    } else {
      command = positional[0]
      args = positional.slice(1)
    }
  }

  if (url) {
    const transport = state.transport && state.transport !== "stdio" ? state.transport : "http"
    const config: Record<string, unknown> = { url }
    if (Object.keys(state.headers).length > 0) config.headers = state.headers
    const resolved = name ? sanitizeMcpName(name) : ""
    const finalName = resolved || guessNameFromUrl(url)
    if (!resolved) warnings.push({ code: "guessed-name", name: finalName })
    return { kind: "command", drafts: [{ name: finalName, transport, config }], warnings }
  }

  if (!command) {
    return { kind: "command", drafts: [], warnings, error: "missing-target" }
  }

  const config: Record<string, unknown> = { command }
  if (args.length > 0) config.args = args
  if (state.cwd) config.cwd = state.cwd
  if (Object.keys(state.env).length > 0) config.env = state.env
  const resolved = name ? sanitizeMcpName(name) : ""
  const finalName = resolved || guessServerName(command, args)
  if (!resolved) warnings.push({ code: "guessed-name", name: finalName })
  return { kind: "command", drafts: [{ name: finalName, transport: "stdio", config }], warnings }
}

function guessNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const segment = parsed.pathname.split("/").filter(Boolean).pop()
    const base = segment && segment !== "mcp" && segment !== "sse" ? segment : parsed.hostname
    return sanitizeMcpName(base) || "mcp-server"
  } catch {
    return "mcp-server"
  }
}

/**
 * Pull leading `KEY=value` assignments off a bare command line into `env`,
 * the way a shell would. `API_KEY=abc npx -y server` is how half the READMEs
 * in the ecosystem show credentials.
 */
function liftEnvPrefix(tokens: string[]): { env: Record<string, string>; rest: string[] } {
  const env: Record<string, string> = {}
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    const pair = splitKeyValue(tokens[index], /=/)
    if (pair) env[pair[0]] = pair[1]
    index += 1
  }
  return { env, rest: tokens.slice(index) }
}

/**
 * Parse one install command. Understands `<agent> mcp add …` for every CLI in
 * {@link AGENT_BINARIES}, `code --add-mcp '<json>'`, and a bare command line
 * (optionally with a `KEY=value` prefix).
 */
export function parseMcpInstallCommand(input: string): McpTransferParse {
  const text = stripPromptChrome(input)
  if (!text) return { kind: "empty", drafts: [], warnings: [], error: "empty" }

  const tokens = tokenizeShellCommand(text)
  if (!tokens || tokens.length === 0) {
    return { kind: "command", drafts: [], warnings: [], error: "unrecognized" }
  }

  const lifted = liftEnvPrefix(tokens)
  let rest = lifted.rest
  if (rest.length === 0) return { kind: "command", drafts: [], warnings: [], error: "unrecognized" }

  const binary = (rest[0].split(/[\\/]/).pop() ?? rest[0]).toLowerCase()
  let recognizedCli = false

  if (AGENT_BINARIES.has(binary)) {
    // `<bin> mcp add|add-json …` — drop the three leading verbs.
    const verbs = rest.slice(1, 3).map((token) => token.toLowerCase())
    if (verbs[0] === "mcp" && (verbs[1] === "add" || verbs[1] === "add-json")) {
      recognizedCli = true
      const isJsonForm = verbs[1] === "add-json"
      rest = rest.slice(3)
      if (isJsonForm) {
        // `add-json <name> '<json>'` — the payload is the last positional.
        const state = parseFlags(rest)
        const [name, payload] = state.positional
        if (payload) {
          const parsed = parseMcpConfigJson(payload, name)
          return { ...parsed, kind: "command" }
        }
        return { kind: "command", drafts: [], warnings: state.warnings, error: "invalid-json" }
      }
    }
  } else if (binary === "code" || binary === "code-insiders" || binary === "cursor") {
    recognizedCli = true
    rest = rest.slice(1)
  }

  const state = parseFlags(rest)
  if (!recognizedCli) {
    // Bare command line: everything is the child process, and any lifted
    // `KEY=value` prefix is its environment.
    const command = rest[0]
    const args = rest.slice(1)
    if (!command) return { kind: "command", drafts: [], warnings: [], error: "missing-target" }
    if (looksLikeUrl(command)) {
      const name = guessNameFromUrl(command)
      return {
        kind: "command",
        drafts: [{ name, transport: "http", config: { url: command } }],
        warnings: [{ code: "guessed-name", name }],
      }
    }
    const config: Record<string, unknown> = { command }
    if (args.length > 0) config.args = args
    if (Object.keys(lifted.env).length > 0) config.env = lifted.env
    const name = guessServerName(command, args)
    return {
      kind: "command",
      drafts: [{ name, transport: "stdio", config }],
      warnings: [{ code: "guessed-name", name }],
    }
  }

  // Env lifted off the front of a recognized CLI invocation still belongs to
  // the child process.
  for (const [key, value] of Object.entries(lifted.env)) state.env[key] = value
  return (
    draftFromFlags(state) ?? { kind: "command", drafts: [], warnings: [], error: "unrecognized" }
  )
}

function entriesOf(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const root = parsed as Record<string, unknown>
  for (const key of ["mcpServers", "servers", "mcp_servers", "mcp.servers"]) {
    const candidate = root[key]
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>
    }
  }
  // VS Code nests the map one level deeper under `mcp`.
  const nested = root.mcp
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return entriesOf(nested)
  }
  return null
}

/**
 * Parse a pasted JSON block. Accepts the wrapped map every agent writes
 * (`{"mcpServers": {…}}`, `{"servers": {…}}`, `{"mcp_servers": {…}}`), a bare
 * `{name: entry}` map, and a single entry object (`{"command": …}`) — the last
 * of which is what a README shows when it documents one server.
 */
export function parseMcpConfigJson(input: string, fallbackName?: string): McpTransferParse {
  const text = stripPromptChrome(input)
  if (!text) return { kind: "empty", drafts: [], warnings: [], error: "empty" }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: "json", drafts: [], warnings: [], error: "invalid-json" }
  }

  const warnings: McpTransferWarning[] = []
  const drafts: McpTransferDraft[] = []
  const pushEntry = (rawName: string, raw: unknown, guessed: boolean) => {
    const normalized = normalizeMcpEntry(raw)
    if (!normalized) {
      warnings.push({ code: "skipped-entry", name: rawName })
      return
    }
    const name =
      sanitizeMcpName(rawName) ||
      guessServerName(
        typeof normalized.config.command === "string" ? normalized.config.command : "mcp",
        Array.isArray(normalized.config.args) ? (normalized.config.args as string[]) : []
      )
    if (guessed) warnings.push({ code: "guessed-name", name })
    else if (name !== rawName.trim()) warnings.push({ code: "renamed", from: rawName, to: name })
    drafts.push({ name, transport: normalized.transport, config: normalized.config })
  }

  const map = entriesOf(parsed)
  if (map) {
    for (const [name, raw] of Object.entries(map)) pushEntry(name, raw, false)
  } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const single = parsed as Record<string, unknown>
    // A single entry, named by an inline `name` field (the `--add-mcp` shape),
    // by the caller (`add-json <name>`), or guessed from the command.
    const inline = typeof single.name === "string" ? single.name : undefined
    const rawName = inline ?? fallbackName
    const entry = { ...single }
    delete entry.name
    if (normalizeMcpEntry(entry)) {
      pushEntry(rawName ?? "", entry, !rawName)
    } else {
      // A bare `{ someName: {...} }` map that `entriesOf` didn't recognize.
      for (const [name, raw] of Object.entries(single)) pushEntry(name, raw, false)
    }
  }

  if (drafts.length === 0) {
    return { kind: "json", drafts: [], warnings, error: "no-entries" }
  }
  return { kind: "json", drafts, warnings }
}

/**
 * Auto-detect what was pasted. JSON wins when the text opens a brace, because
 * a JSON block can never be a valid command line and the reverse guess would
 * silently tokenize a config into garbage.
 */
export function parseMcpTransferInput(input: string): McpTransferParse {
  const text = stripPromptChrome(input)
  if (!text) return { kind: "empty", drafts: [], warnings: [], error: "empty" }
  if (text.startsWith("{") || text.startsWith("[")) return parseMcpConfigJson(text)
  return parseMcpInstallCommand(text)
}

/** Quote a token for a POSIX shell only when it actually needs quoting. */
export function shellQuote(value: string): string {
  if (value === "") return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface InstallCommandTarget {
  /** Binary that owns the grammar. */
  binary: string
  /** Whether the CLI wants the child command after a bare `--`. */
  separator: boolean
  /** Whether it accepts `--transport`. */
  transportFlag: boolean
}

/** The CLIs we can emit an `mcp add` line for, keyed by our own agent ids. */
export const INSTALL_COMMAND_TARGETS: Partial<Record<AgentId, InstallCommandTarget>> = {
  "claude-code": { binary: "claude", separator: true, transportFlag: true },
  codex: { binary: "codex", separator: true, transportFlag: false },
  gemini: { binary: "gemini", separator: false, transportFlag: true },
  opencode: { binary: "opencode", separator: true, transportFlag: false },
  cognia: { binary: "cognia", separator: true, transportFlag: true },
}

export interface InstallCommandInput {
  name: string
  transport: McpTransport
  config: Record<string, unknown>
}

/**
 * Render a server as an `mcp add` command for one agent CLI, or as a bare
 * shell line when `agent` names no CLI we know.
 *
 * Secret references are emitted as their `secretRef` locator rather than a
 * resolved value: the point of this string is that the user pastes it into a
 * terminal or a chat, and neither is a place to put a decrypted token.
 */
export function buildMcpInstallCommand(server: InstallCommandInput, agent?: AgentId): string {
  const target = agent ? INSTALL_COMMAND_TARGETS[agent] : undefined
  const config = server.config ?? {}
  const parts: string[] = []

  if (!target) {
    // No CLI grammar for this agent — a runnable shell line is still useful.
    if (server.transport !== "stdio") return String(renderValue(config.url) ?? "")
    for (const [key, value] of Object.entries(asRecord(config.env))) {
      parts.push(`${key}=${shellQuote(renderValue(value) ?? "")}`)
    }
    parts.push(shellQuote(String(config.command ?? "")))
    for (const arg of asArray(config.args)) parts.push(shellQuote(renderValue(arg) ?? ""))
    return parts.join(" ")
  }

  parts.push(target.binary, "mcp", "add")
  if (target.transportFlag && server.transport !== "stdio") {
    parts.push("--transport", server.transport)
  }
  if (server.transport === "stdio") {
    for (const [key, value] of Object.entries(asRecord(config.env))) {
      parts.push("--env", shellQuote(`${key}=${renderValue(value) ?? ""}`))
    }
  } else {
    for (const [key, value] of Object.entries(asRecord(config.headers))) {
      parts.push("--header", shellQuote(`${key}: ${renderValue(value) ?? ""}`))
    }
  }
  parts.push(shellQuote(server.name))

  if (server.transport === "stdio") {
    if (target.separator) parts.push("--")
    parts.push(shellQuote(String(config.command ?? "")))
    for (const arg of asArray(config.args)) parts.push(shellQuote(renderValue(arg) ?? ""))
  } else {
    parts.push(shellQuote(renderValue(config.url) ?? ""))
  }
  return parts.join(" ")
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Render a config leaf, keeping a SecretRef as its locator, never its value. */
function renderValue(value: unknown): string | null {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && "secretRef" in value) {
    return `\${${String((value as { secretRef: string }).secretRef)}}`
  }
  return value === undefined || value === null ? null : String(value)
}

/**
 * Serialize servers as the JSON one agent expects. With no `agent`, emits the
 * canonical `{"mcpServers": {…}}` block that Claude Code, Cursor and friends
 * all read. With an agent, delegates to that adapter's own `project()` so the
 * output is byte-identical to what the sync writer would have produced.
 */
export function buildMcpTransferJson(
  servers: ReadonlyArray<InstallCommandInput>,
  agent?: AgentId
): string {
  if (agent) {
    const adapter = MCP_AGENT_ADAPTERS.find((candidate) => candidate.id === agent)
    if (adapter?.writable) {
      const rows = servers.map((server) => ({
        id: `transfer_${server.name}`,
        name: server.name,
        transport: server.transport,
        config: server.config,
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      }))
      const projected = adapter.project(null, rows as never, new Set(rows.map((r) => r.name)))
      return JSON.stringify(projected, null, 2)
    }
  }
  const mcpServers: Record<string, unknown> = {}
  for (const server of [...servers].sort((a, b) => a.name.localeCompare(b.name))) {
    mcpServers[server.name] = denormalizeMcpEntry(server.transport, server.config)
  }
  return JSON.stringify({ mcpServers }, null, 2)
}
