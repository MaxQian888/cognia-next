/**
 * `/mcp` controller — list, enable/disable, and add MCP servers. Configuration
 * is file-based (`.mcp.json`, Claude-Code convention); the loaded servers feed
 * the `preloadedMcpServers` build-options seam (see `session-runner`). Toggling
 * writes the `mcp-state.json` disabled overlay; adding writes `~/.cognia/mcp.json`.
 */
import nodeFs from "node:fs"
import path from "node:path"

import type { McpServer, McpTransport } from "@/lib/claude/types"

import { loadMcpServers } from "../../mcp/load-mcp-config"
import { applyDisabled, readDisabled, setDisabled } from "../../mcp/mcp-state"
import { createMcpOAuthProvider } from "../../mcp/oauth-provider"
import { clearAuthEntry, hasAuthTokens } from "../../mcp/oauth-store"
import { authenticateMcpServer, type AuthFlowResult } from "../../mcp/oauth-flow"
import {
  applyPresetFields,
  collectMcpPresets,
  findCatalogPreset,
  missingPresetFields,
  type CatalogPreset,
} from "../../mcp/preset-catalog"
import {
  probeMcpServer,
  type McpProbeResult,
  type McpServerStatus,
} from "../../mcp/probe-mcp-server"
import { probeMcpTools, type McpToolInfo } from "../../mcp/probe-mcp-tools"
import { openDocument } from "./shared"
import { buildPromptsDocument, buildResourcesDocument, buildToolsDocument } from "./tool-doc"
import type { TuiAction } from "../state/types"

export interface McpDeps {
  dispatch: (action: TuiAction) => void
  roots: string[]
  home: string
  load?: () => McpServer[]
  setServerDisabled?: (name: string, disabled: boolean) => void
  addServer?: (name: string, transport: McpTransport, config: Record<string, unknown>) => void
  /** Live tool probe (`/mcp tools`); defaults to {@link probeMcpTools}. */
  probe?: (server: McpServer) => Promise<McpToolInfo[]>
  /** Rich probe (status + resources + prompts); defaults to {@link probeMcpServer}. */
  probeServer?: (server: McpServer, opts?: { statusOnly?: boolean }) => Promise<McpProbeResult>
  /** Run the OAuth flow (`/mcp auth`); defaults to {@link authenticateMcpServer}. */
  authenticate?: (server: McpServer, onAuthUrl: (url: string) => void) => Promise<AuthFlowResult>
  /** Drop stored OAuth credentials (`/mcp logout`). */
  logout?: (name: string) => boolean
  /** Whether a server has stored OAuth tokens (for `/mcp show`). */
  hasTokens?: (name: string) => boolean
  /** Preset gallery source (`/mcp presets`, `/mcp add --preset`). */
  collectPresets?: () => Promise<CatalogPreset[]>
}

/** Flag keys consumed by `/mcp add` itself; everything else is a preset field. */
const RESERVED_ADD_FLAGS = new Set(["name", "preset", "transport", "command", "url", "args"])

function loadServers(deps: McpDeps): McpServer[] {
  if (deps.load) return deps.load()
  return applyDisabled(loadMcpServers(deps.roots), readDisabled(deps.home))
}

/** One-glance status glyph + label for the `/mcp list` overlay. */
const STATUS_LABEL: Record<McpServerStatus, string> = {
  connected: "✓ connected",
  needs_auth: "⚠ needs auth",
  failed: "✗ failed",
  disabled: "○ disabled",
}

/**
 * OAuth provider for a non-interactive status probe. Returns one only when the
 * server already has stored tokens — so an authorized remote uses them
 * (→ connected) while an un-authorized one fails fast with 401 (→ needs_auth)
 * instead of triggering a dynamic-client-registration round-trip on every
 * `/mcp list`. Never opens a browser (the redirect is a no-op).
 */
export function probeAuthProvider(home: string, server: McpServer): unknown {
  if (server.transport === "stdio" || !hasAuthTokens(home, server.name)) return undefined
  return createMcpOAuthProvider({
    home,
    serverName: server.name,
    redirectUrl: "http://127.0.0.1/cognia-mcp-probe",
    onRedirect: () => undefined,
  })
}

/** Default rich probe — status + (optionally) resources/prompts in one connect. */
function defaultProbeServer(home: string) {
  return (server: McpServer, opts: { statusOnly?: boolean } = {}) =>
    probeMcpServer(server, {
      skipResources: opts.statusOnly,
      skipPrompts: opts.statusOnly,
      authProvider: (s) => probeAuthProvider(home, s),
    })
}

function defaultAuthenticate(deps: McpDeps) {
  return (server: McpServer, onAuthUrl: (url: string) => void) =>
    authenticateMcpServer(server, { home: deps.home, onAuthUrl })
}

/** Parse a `--flag value …` arg string into a flat record (values may span
 * tokens until the next `--flag`). */
export function parseFlags(args: string): Record<string, string> {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: Record<string, string> = {}
  let key: string | null = null
  let val: string[] = []
  const flush = () => {
    if (key) out[key] = val.join(" ")
    key = null
    val = []
  }
  for (const t of tokens) {
    if (t.startsWith("--")) {
      flush()
      key = t.slice(2)
    } else if (key) {
      val.push(t)
    }
  }
  flush()
  return out
}

export async function mcpList(deps: McpDeps): Promise<void> {
  const servers = loadServers(deps)
  if (servers.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message:
        "No MCP servers configured. Add one with /mcp add, or create .mcp.json in this folder.",
    })
    return
  }
  deps.dispatch({
    type: "NOTICE",
    message: `Probing ${servers.length} MCP server${servers.length === 1 ? "" : "s"}…`,
  })
  const probe = deps.probeServer ?? defaultProbeServer(deps.home)
  const statuses = await Promise.all(
    servers.map((s) =>
      probe(s, { statusOnly: true }).then(
        (r) => r.status,
        () => "failed" as McpServerStatus
      )
    )
  )
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "MCP servers (Enter shows details)",
      items: servers.map((s, i) => ({
        id: s.name,
        label: s.name,
        hint: `${s.transport} · ${STATUS_LABEL[statuses[i]]}`,
      })),
      index: 0,
      onSelectCommand: "mcp show",
    },
  })
}

/** Describe the configured endpoint for a server, redacting secret values. */
function describeEndpoint(server: McpServer): string[] {
  const cfg = server.config
  if (server.transport === "stdio") {
    const args = Array.isArray(cfg.args) ? (cfg.args as string[]) : []
    const command = [String(cfg.command ?? ""), ...args].join(" ").trim()
    const lines = [`  command: ${command || "—"}`]
    const env = cfg.env && typeof cfg.env === "object" ? Object.keys(cfg.env as object) : []
    if (env.length > 0) lines.push(`  env: ${env.join(", ")}`)
    return lines
  }
  const lines = [`  url: ${String(cfg.url ?? "—")}`]
  const headers =
    cfg.headers && typeof cfg.headers === "object" ? Object.keys(cfg.headers as object) : []
  if (headers.length > 0) lines.push(`  headers: ${headers.join(", ")}`)
  return lines
}

/** `/mcp show <name>` — render a server's configuration detail (no connection). */
export function mcpShow(name: string, deps: McpDeps): void {
  const key = name.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /mcp show <name>" })
    return
  }
  const server = loadServers(deps).find((s) => s.name === key)
  if (!server) {
    deps.dispatch({ type: "NOTICE", message: `MCP server "${key}" not found.` })
    return
  }
  const lines = [
    `${server.name} — ${server.enabled ? "enabled" : "disabled"}`,
    `  transport: ${server.transport}`,
    ...describeEndpoint(server),
  ]
  if (server.pluginId) lines.push(`  source: plugin ${server.pluginId}`)
  if (server.transport !== "stdio") {
    const authed = (deps.hasTokens ?? ((n) => hasAuthTokens(deps.home, n)))(server.name)
    lines.push(
      authed
        ? `  auth: signed in (/mcp logout ${server.name})`
        : `  auth: not signed in (/mcp auth ${server.name})`
    )
  }
  lines.push(`  tools: /mcp tools ${server.name}`)
  lines.push(`  resources: /mcp resources ${server.name}`)
  lines.push(`  prompts: /mcp prompts ${server.name}`)
  lines.push(`  toggle: /mcp toggle ${server.name}`)
  deps.dispatch({ type: "NOTICE", message: lines.join("\n") })
}

/** Shared probe-then-render for `/mcp resources` and `/mcp prompts`. */
async function probeAndRender(
  name: string,
  kind: "resources" | "prompts",
  deps: McpDeps
): Promise<void> {
  const key = name.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: `Usage: /mcp ${kind} <name>` })
    return
  }
  const server = loadServers(deps).find((s) => s.name === key)
  if (!server) {
    deps.dispatch({ type: "NOTICE", message: `MCP server "${key}" not found.` })
    return
  }
  deps.dispatch({ type: "NOTICE", message: `Connecting to "${key}" to list ${kind}…` })
  let result: McpProbeResult
  try {
    result = await (deps.probeServer ?? defaultProbeServer(deps.home))(server)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    deps.dispatch({ type: "NOTICE", message: `Could not connect to "${key}": ${reason}` })
    return
  }
  if (result.status === "needs_auth") {
    deps.dispatch({
      type: "NOTICE",
      message: `"${key}" needs authorization. Run /mcp auth ${key}.`,
    })
    return
  }
  if (result.status !== "connected") {
    deps.dispatch({
      type: "NOTICE",
      message: `Could not connect to "${key}": ${result.error ?? result.status}`,
    })
    return
  }
  const items = kind === "resources" ? result.resources : result.prompts
  const count = items.length
  openDocument(deps.dispatch, {
    title: `${kind === "resources" ? "Resources" : "Prompts"} · ${key} (${count})`,
    body:
      kind === "resources"
        ? buildResourcesDocument(
            result.resources,
            `${count} resource${count === 1 ? "" : "s"} advertised by \`${key}\`.`
          )
        : buildPromptsDocument(
            result.prompts,
            `${count} prompt${count === 1 ? "" : "s"} advertised by \`${key}\`.`
          ),
    format: "markdown",
  })
}

/** `/mcp resources <name>` — connect and list the server's resources. */
export function mcpResources(name: string, deps: McpDeps): Promise<void> {
  return probeAndRender(name, "resources", deps)
}

/** `/mcp prompts <name>` — connect and list the server's prompts. */
export function mcpPrompts(name: string, deps: McpDeps): Promise<void> {
  return probeAndRender(name, "prompts", deps)
}

/** `/mcp auth <name>` — run the OAuth authorization-code flow for a remote server. */
export async function mcpAuth(name: string, deps: McpDeps): Promise<void> {
  const key = name.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /mcp auth <name>" })
    return
  }
  const server = loadServers(deps).find((s) => s.name === key)
  if (!server) {
    deps.dispatch({ type: "NOTICE", message: `MCP server "${key}" not found.` })
    return
  }
  if (server.transport === "stdio") {
    deps.dispatch({
      type: "NOTICE",
      message: `"${key}" is a stdio server — OAuth applies to sse/http servers only.`,
    })
    return
  }
  deps.dispatch({ type: "NOTICE", message: `Authorizing "${key}" — opening your browser…` })
  const onAuthUrl = (url: string) =>
    deps.dispatch({
      type: "NOTICE",
      message: `If the browser didn't open, visit:\n${url}`,
    })
  const result = await (deps.authenticate ?? defaultAuthenticate(deps))(server, onAuthUrl)
  deps.dispatch({ type: "NOTICE", message: result.message })
}

/** `/mcp logout <name>` — delete a server's stored OAuth credentials. */
export function mcpLogout(name: string, deps: McpDeps): void {
  const key = name.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /mcp logout <name>" })
    return
  }
  const removed = (deps.logout ?? ((n) => clearAuthEntry(deps.home, n)))(key)
  deps.dispatch({
    type: "NOTICE",
    message: removed
      ? `Signed out of "${key}" (cleared stored credentials).`
      : `No stored credentials for "${key}".`,
  })
}

/** `/mcp tools <name>` — connect to the server and list its advertised tools. */
export async function mcpTools(name: string, deps: McpDeps): Promise<void> {
  const key = name.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /mcp tools <name>" })
    return
  }
  const server = loadServers(deps).find((s) => s.name === key)
  if (!server) {
    deps.dispatch({ type: "NOTICE", message: `MCP server "${key}" not found.` })
    return
  }
  deps.dispatch({ type: "NOTICE", message: `Connecting to "${key}" to list tools…` })
  let tools: McpToolInfo[]
  try {
    tools = await (deps.probe ?? probeMcpTools)(server)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    deps.dispatch({ type: "NOTICE", message: `Could not list tools for "${key}": ${reason}` })
    return
  }
  if (tools.length === 0) {
    deps.dispatch({ type: "NOTICE", message: `"${key}" advertises no tools.` })
    return
  }
  openDocument(deps.dispatch, {
    title: `Tools · ${key} (${tools.length})`,
    body: buildToolsDocument(
      tools.map((t) => ({ name: t.name, description: t.description, schema: t.inputSchema })),
      `${tools.length} tool${tools.length === 1 ? "" : "s"} advertised by \`${key}\`.`
    ),
    format: "markdown",
  })
}

export function mcpToggle(name: string, deps: McpDeps): void {
  const server = loadServers(deps).find((s) => s.name === name)
  if (!server) {
    deps.dispatch({ type: "NOTICE", message: `MCP server "${name}" not found.` })
    return
  }
  const disable = server.enabled // currently on → disable
  ;(deps.setServerDisabled ?? ((n, d) => setDisabled(deps.home, n, d)))(name, disable)
  deps.dispatch({
    type: "NOTICE",
    message: `MCP server "${name}" ${disable ? "disabled" : "enabled"}.`,
  })
}

export function mcpSetEnabled(name: string, enabled: boolean, deps: McpDeps): void {
  ;(deps.setServerDisabled ?? ((n, d) => setDisabled(deps.home, n, d)))(name, !enabled)
  deps.dispatch({
    type: "NOTICE",
    message: `MCP server "${name}" ${enabled ? "enabled" : "disabled"}.`,
  })
}

function defaultAddServer(home: string) {
  return (name: string, transport: McpTransport, config: Record<string, unknown>) => {
    const file = path.join(home, "mcp.json")
    let doc: { mcpServers?: Record<string, unknown> } = {}
    try {
      if (nodeFs.existsSync(file)) doc = JSON.parse(nodeFs.readFileSync(file, "utf8"))
    } catch {
      doc = {}
    }
    doc.mcpServers = doc.mcpServers ?? {}
    doc.mcpServers[name] = transport === "stdio" ? config : { ...config }
    nodeFs.mkdirSync(path.dirname(file), { recursive: true })
    nodeFs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8")
  }
}

function loadCatalog(deps: McpDeps): Promise<CatalogPreset[]> {
  return (
    deps.collectPresets ?? (() => collectMcpPresets({ roots: deps.roots, home: deps.home }))
  )()
}

/** `/mcp presets` — browse the built-in + plugin-contributed preset gallery. */
export async function mcpPresets(deps: McpDeps): Promise<void> {
  const catalog = await loadCatalog(deps)
  const lines: string[] = [
    `${catalog.length} preset${catalog.length === 1 ? "" : "s"} available.`,
    "",
  ]
  for (const { preset, source } of catalog) {
    const tag = source === "built-in" ? "built-in" : source
    lines.push(`### ${preset.icon ? `${preset.icon} ` : ""}${preset.name}  \`${preset.id}\``)
    lines.push("", `${preset.description || "—"}  ·  _${preset.transport}_  ·  _${tag}_`)
    const required = preset.fields.filter((f) => f.placement !== "header")
    const optional = preset.fields.filter((f) => f.placement === "header")
    if (required.length > 0) {
      lines.push("", `Required: ${required.map((f) => `\`--${f.key} <${f.label}>\``).join(", ")}`)
    }
    if (optional.length > 0) {
      lines.push("", `Optional: ${optional.map((f) => `\`--${f.key} <${f.label}>\``).join(", ")}`)
    }
    lines.push(
      "",
      `Add: \`/mcp add --preset ${preset.id} --name <name>${
        required.length > 0 ? ` --${required[0].key} …` : ""
      }\``
    )
    lines.push("")
  }
  openDocument(deps.dispatch, {
    title: `MCP presets (${catalog.length})`,
    body: lines.join("\n").trimEnd(),
    format: "markdown",
  })
}

async function mcpAddFromPreset(flags: Record<string, string>, deps: McpDeps): Promise<void> {
  const catalog = await loadCatalog(deps)
  const found = findCatalogPreset(catalog, flags.preset.trim())
  if (!found) {
    deps.dispatch({
      type: "NOTICE",
      message: `Unknown preset "${flags.preset}". See /mcp presets for the list.`,
    })
    return
  }
  const { preset } = found
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(flags)) {
    if (!RESERVED_ADD_FLAGS.has(k)) values[k] = v
  }
  const missing = missingPresetFields(preset, values)
  if (missing.length > 0) {
    deps.dispatch({
      type: "NOTICE",
      message: `"${preset.id}" needs: ${missing.map((f) => `--${f.key} <${f.label}>`).join(", ")}`,
    })
    return
  }
  const config = applyPresetFields(preset, values)
  const name = flags.name?.trim() || preset.id
  ;(deps.addServer ?? defaultAddServer(deps.home))(name, preset.transport, config)
  deps.dispatch({
    type: "NOTICE",
    message: `Added MCP server "${name}" from preset "${preset.id}" (${preset.transport}). Applies on the next turn.`,
  })
}

export async function mcpAdd(args: string, deps: McpDeps): Promise<void> {
  const flags = parseFlags(args)
  if (flags.preset) return mcpAddFromPreset(flags, deps)
  const name = flags.name?.trim()
  if (!name) {
    deps.dispatch({
      type: "NOTICE",
      message:
        "Usage: /mcp add --name <n> --transport stdio --command <cmd> | --url <url>\n   or: /mcp add --preset <id> --name <n> [--<field> <value> …]  (see /mcp presets)",
    })
    return
  }
  const transport = (flags.transport?.trim() || "stdio") as McpTransport
  if (transport === "stdio" && !flags.command) {
    deps.dispatch({ type: "NOTICE", message: "stdio transport needs --command." })
    return
  }
  if (transport !== "stdio" && !flags.url) {
    deps.dispatch({ type: "NOTICE", message: `${transport} transport needs --url.` })
    return
  }
  const config: Record<string, unknown> =
    transport === "stdio"
      ? { command: flags.command, ...(flags.args ? { args: flags.args.split(/\s+/) } : {}) }
      : { url: flags.url }
  ;(deps.addServer ?? defaultAddServer(deps.home))(name, transport, config)
  deps.dispatch({
    type: "NOTICE",
    message: `Added MCP server "${name}" (${transport}). Applies on the next turn.`,
  })
}
