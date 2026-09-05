/**
 * `/mcp` controller — list, enable/disable, and add MCP servers. Configuration
 * is file-based (`.mcp.json`, Claude-Code convention); the loaded servers feed
 * the `preloadedMcpServers` build-options seam (see `session-runner`). Toggling
 * writes the `mcp-state.json` disabled overlay; adding writes `~/.cognia/mcp.json`.
 */
import nodeFs from "node:fs"
import path from "node:path"

import { denormalizeMcpEntry } from "@/lib/claude/agents/shared"

import type { McpServer, McpTransport } from "@cognia/agent-config-types"

import { loadMcpServers } from "../../mcp/load-mcp-config"
import {
  applyDisabled,
  mcpToolGateName,
  readDisabled,
  readDisabledTools,
  setDisabled,
  setDisabledTool,
} from "../../mcp/mcp-state"
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
import { type McpProbeCache, toCacheEntry } from "./mcp-cache"
import { formatServerStatusSummary } from "./mcp-log-model"
import { openDocument } from "./shared"
import { buildPromptsDocument, buildResourcesDocument, buildToolsDocument } from "./tool-doc"
import type { TuiAction } from "../state/types"

export interface McpDeps {
  /** Suppress late results and new work after the runtime request is cancelled. */
  signal?: AbortSignal
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
  /** Read the per-tool disable overlay (`/mcp` panel). Injected in tests. */
  readDisabledTools?: () => Set<string>
  /** Flip one tool's disabled state (`/mcp` panel). Injected in tests. */
  setDisabledTool?: (gateName: string, disabled: boolean) => void
  /** Remove a server from `~/.cognia/mcp.json`. Returns false when the server
   * isn't user-owned (project `.mcp.json` / plugin). Injected in tests. */
  removeServer?: (name: string) => boolean
  /** Shared probe cache (created once at App startup). When present, the panel
   * and tool list render from the last probe instead of re-connecting on every
   * open; only reconnect/enable/add re-probe. Absent in unit tests that assert
   * the raw probe behaviour, and in the command-path deps. */
  probeCache?: McpProbeCache
  /** Injected clock (for the cache's `probedAt` stamp). Defaults to Date.now. */
  now?: () => number
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
function defaultProbeServer(home: string, signal?: AbortSignal) {
  return (server: McpServer, opts: { statusOnly?: boolean } = {}) =>
    probeMcpServer(server, {
      signal,
      skipResources: opts.statusOnly,
      skipPrompts: opts.statusOnly,
      authProvider: (s) => probeAuthProvider(home, s),
    })
}

function defaultProbeTools(deps: McpDeps) {
  return (server: McpServer) =>
    probeMcpTools(server, {
      signal: deps.signal,
      authProvider: probeAuthProvider(deps.home, server),
    })
}

function defaultAuthenticate(deps: McpDeps) {
  return (server: McpServer, onAuthUrl: (url: string) => void) =>
    authenticateMcpServer(server, { home: deps.home, onAuthUrl, signal: deps.signal })
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

/**
 * `/mcp` (bare) — open the interactive server panel and probe every enabled
 * server concurrently, patching each row's status as its probe resolves (so the
 * board lights up live instead of blocking on the slowest server). Disabled
 * servers show `disabled` without a probe.
 */
export async function mcpPanel(deps: McpDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const servers = loadServers(deps)
  if (servers.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message:
        "No MCP servers configured. Add one with /mcp add, or create .mcp.json in this folder.",
    })
    return
  }
  const cache = deps.probeCache
  const enabledServers = servers.filter((s) => s.enabled)
  // Probe servers we have no cached result for, PLUS any cached as `failed` — a
  // warmed cache (from the startup warm or a prior open) makes re-opening `/mcp`
  // instant for healthy servers, but a boot-time transient failure must NOT
  // stick: re-probe it on open so a recovered server can flip to `connected`
  // instead of requiring a manual reconnect.
  const toProbe = enabledServers.filter((s) => {
    const cached = cache?.get(s.name)
    return !cached || cached.status === "failed"
  })
  const toProbeNames = new Set(toProbe.map((s) => s.name))
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "mcp",
      probing: toProbe.length > 0,
      servers: servers.map((s) => {
        const cached = s.enabled ? cache?.get(s.name) : undefined
        // A server being re-probed shows `pending` (not its stale `failed`).
        const status: McpServerStatus | "pending" = !s.enabled
          ? "disabled"
          : toProbeNames.has(s.name)
            ? "pending"
            : (cached?.status ?? "pending")
        return {
          name: s.name,
          transport: s.transport,
          enabled: s.enabled,
          status,
          ...(cached ? { toolCount: cached.toolCount } : {}),
        }
      }),
    },
  })
  if (toProbe.length === 0) return
  const probe = deps.probeServer ?? defaultProbeServer(deps.home, deps.signal)
  const now = deps.now ?? Date.now
  let remaining = toProbe.length
  await Promise.all(
    toProbe.map((s) =>
      probe(s, { statusOnly: true })
        .then(
          (r) => ({
            status: r.status,
            error: r.error,
            tools: r.tools,
            resources: r.resources,
            prompts: r.prompts,
          }),
          (e: unknown) => ({
            status: "failed" as McpServerStatus,
            error: e instanceof Error ? e.message : String(e),
            tools: [] as McpToolInfo[],
            resources: [],
            prompts: [],
          })
        )
        .then((result) => {
          if (deps.signal?.aborted) return
          cache?.set(s.name, toCacheEntry(result, now()))
          remaining -= 1
          deps.dispatch({
            type: "MCP_STATUS_PATCH",
            name: s.name,
            patch: { status: result.status, error: result.error, toolCount: result.tools.length },
            doneProbing: remaining === 0,
          })
        })
    )
  )
}

/**
 * `/mcp logs` — open the captured MCP log panel. Rows render from the live
 * `state.mcpLogs` buffer (fed by the sidecar's `mcp_log` + generic `log`
 * stream); this just opens the overlay with a snapshot of each server's status
 * (from the warmed probe cache) for the header. Never probes — the panel is a
 * pure view over already-captured output.
 */
export function mcpLogsPanel(deps: McpDeps): void {
  const cache = deps.probeCache
  const servers = loadServers(deps).map((s) => ({
    name: s.name,
    status: !s.enabled ? "disabled" : (cache?.get(s.name)?.status ?? "pending"),
  }))
  const statusSummary = formatServerStatusSummary(servers)
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: { kind: "mcpLogs", ...(statusSummary ? { statusSummary } : {}) },
  })
}

/**
 * Boot-time MCP warm + auth check. Probes enabled servers once at startup and,
 * when a shared {@link McpProbeCache} is supplied (the App path), seeds it with
 * every server's status + advertised tools — so the first `/mcp` open and the
 * per-tool panel render instantly instead of re-connecting ("load MCP by default
 * on startup"). It still emits the proactive NOTICE for each remote server that
 * needs authorization (the hint Claude Code shows), guiding the user to
 * `/mcp auth <name>`. Stdio servers never need auth, so they never trigger a
 * notice; connected / failed probes stay silent to avoid startup noise.
 *
 * Without a cache (the legacy signature used by the startup-notice unit tests)
 * only remote servers are probed — stdio servers are skipped entirely, so no
 * child process is spawned just for an auth check that can never apply.
 */
export async function mcpAuthStartupNotices(deps: McpDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const cache = deps.probeCache
  const enabled = loadServers(deps).filter((s) => s.enabled)
  // With a cache, warm EVERY enabled server (stdio included). Without one, keep
  // the old behaviour: only remote servers matter for the auth notice.
  const targets = cache ? enabled : enabled.filter((s) => s.transport !== "stdio")
  if (targets.length === 0) return
  const probe = deps.probeServer ?? defaultProbeServer(deps.home, deps.signal)
  const now = deps.now ?? Date.now
  await Promise.all(
    targets.map((s) =>
      probe(s, { statusOnly: true })
        .then(
          (r) => ({
            status: r.status,
            error: r.error,
            tools: r.tools,
            resources: r.resources,
            prompts: r.prompts,
          }),
          (e: unknown) => ({
            status: "failed" as McpServerStatus,
            error: e instanceof Error ? e.message : String(e),
            tools: [] as McpToolInfo[],
            resources: [],
            prompts: [],
          })
        )
        .then((result) => {
          if (deps.signal?.aborted) return
          cache?.set(s.name, toCacheEntry(result, now()))
          if (result.status === "needs_auth" && s.transport !== "stdio") {
            deps.dispatch({
              type: "NOTICE",
              message: `⚠ MCP server "${s.name}" needs authorization — run /mcp auth ${s.name}`,
            })
          } else if (result.status === "failed") {
            // A server that fails to load used to be visible only if the user
            // opened /mcp. Surface it as a transient warn toast so a broken MCP
            // config isn't silently swallowed at startup (probed once per server,
            // so no de-dup needed).
            deps.dispatch({
              type: "TOAST_PUSH",
              severity: "warn",
              message: `MCP server "${s.name}" failed to load`,
              hint: "Open /mcp to see the error.",
            })
          }
        })
    )
  )
}

/** Re-probe a single server (the panel's `r` reconnect action). Patches its row
 * to `pending` first, then the fresh status — the rest of the board is untouched. */
export async function mcpReconnect(name: string, deps: McpDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const server = loadServers(deps).find((s) => s.name === name)
  if (!server) {
    deps.dispatch({ type: "MCP_STATUS_PATCH", name, patch: { status: "failed" } })
    return
  }
  deps.dispatch({ type: "MCP_STATUS_PATCH", name, patch: { status: "pending" } })
  const probe = deps.probeServer ?? defaultProbeServer(deps.home, deps.signal)
  const now = deps.now ?? Date.now
  const result = await probe(server, { statusOnly: true }).then(
    (r) => ({
      status: r.status,
      error: r.error,
      tools: r.tools,
      resources: r.resources,
      prompts: r.prompts,
    }),
    (e: unknown) => ({
      status: "failed" as McpServerStatus,
      error: e instanceof Error ? e.message : String(e),
      tools: [] as McpToolInfo[],
      resources: [],
      prompts: [],
    })
  )
  if (deps.signal?.aborted) return
  // A reconnect is the one action that always re-probes — refresh the cache so
  // the panel reflects the fresh status and a later re-open stays instant.
  deps.probeCache?.set(name, toCacheEntry(result, now()))
  deps.dispatch({
    type: "MCP_STATUS_PATCH",
    name,
    patch: { status: result.status, error: result.error, toolCount: result.tools.length },
  })
}

/**
 * Toggle a server's enabled state from the panel (the `space` action). Persists
 * the `/mcp disable` overlay and patches the row in place; on enable it kicks a
 * fresh probe so the row moves from `pending` to its real status. Returns the
 * new state label (or null when the server vanished) for the caller's notice.
 */
export async function mcpToggleServerInPanel(
  name: string,
  deps: McpDeps
): Promise<"enabled" | "disabled" | null> {
  if (deps.signal?.aborted) return null
  const server = loadServers(deps).find((s) => s.name === name)
  if (!server) return null
  const disable = server.enabled
  ;(deps.setServerDisabled ?? ((n, d) => setDisabled(deps.home, n, d)))(name, disable)
  // Drop the stale cache entry on disable so a later re-enable re-probes; the
  // enable path re-probes immediately (below), refreshing the cache itself.
  if (disable) deps.probeCache?.clear(name)
  deps.dispatch({
    type: "MCP_STATUS_PATCH",
    name,
    patch: { enabled: !disable, status: disable ? "disabled" : "pending" },
  })
  if (!disable) await mcpReconnect(name, deps)
  return disable ? "disabled" : "enabled"
}

/**
 * Open a single server's per-tool enable/disable list (drill-down from the
 * panel). Connects to list the tools, seeds each row's `enabled` from the
 * `disabledTools` overlay, and opens the `mcpTools` overlay.
 */
export async function openMcpToolsPanel(name: string, deps: McpDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const server = loadServers(deps).find((s) => s.name === name)
  if (!server) {
    deps.dispatch({ type: "NOTICE", message: `MCP server "${name}" not found.` })
    return
  }
  const cache = deps.probeCache
  // The panel/startup probe already captured this server's tools (a status-only
  // probe still lists tools) — reuse them so drilling in doesn't re-connect.
  const cached = cache?.get(name)
  let tools: McpToolInfo[]
  if (cached && cached.status === "connected") {
    tools = cached.tools
  } else {
    try {
      tools = await (deps.probe ?? defaultProbeTools(deps))(server)
    } catch (err) {
      if (deps.signal?.aborted) return
      const reason = err instanceof Error ? err.message : String(err)
      deps.dispatch({ type: "NOTICE", message: `Could not list tools for "${name}": ${reason}` })
      return
    }
    if (deps.signal?.aborted) return
    // Fold the freshly-listed tools into the cache so a later open is instant.
    // A successful tool probe means the server is reachable, so record it as
    // `connected` and drop any stale error — otherwise a recovered server that
    // was previously cached as `failed` would keep its failed badge and re-probe
    // on every open (the connected fast-path above only hits on `connected`).
    if (cache) {
      const now = deps.now ?? Date.now
      cache.set(name, {
        status: "connected",
        tools,
        resources: cached?.resources ?? [],
        prompts: cached?.prompts ?? [],
        toolCount: tools.length,
        probedAt: now(),
      })
    }
  }
  if (deps.signal?.aborted) return
  if (tools.length === 0) {
    deps.dispatch({ type: "NOTICE", message: `"${name}" advertises no tools.` })
    return
  }
  const disabled = (deps.readDisabledTools ?? (() => readDisabledTools(deps.home)))()
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "mcpTools",
      server: name,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        enabled: !disabled.has(mcpToolGateName(name, t.name)),
      })),
    },
  })
}

/**
 * Flip one MCP tool's disabled state (the tool panel's `space` action). Writes
 * the `disabledTools` overlay — `session-runner` unions it into `disallowedTools`
 * so the model stops seeing the tool on the next turn. Pure persistence; the
 * panel updates its own row optimistically.
 */
export function mcpToggleTool(server: string, tool: string, enabled: boolean, deps: McpDeps): void {
  const gate = mcpToolGateName(server, tool)
  ;(deps.setDisabledTool ?? ((g, d) => setDisabledTool(deps.home, g, d)))(gate, !enabled)
}

export async function mcpList(deps: McpDeps): Promise<void> {
  if (deps.signal?.aborted) return
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
  const probe = deps.probeServer ?? defaultProbeServer(deps.home, deps.signal)
  const statuses = await Promise.all(
    servers.map((s) =>
      probe(s, { statusOnly: true }).then(
        (r) => r.status,
        () => "failed" as McpServerStatus
      )
    )
  )
  if (deps.signal?.aborted) return
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
  if (deps.signal?.aborted) return
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
    result = await (deps.probeServer ?? defaultProbeServer(deps.home, deps.signal))(server)
  } catch (err) {
    if (deps.signal?.aborted) return
    const reason = err instanceof Error ? err.message : String(err)
    deps.dispatch({ type: "NOTICE", message: `Could not connect to "${key}": ${reason}` })
    return
  }
  if (deps.signal?.aborted) return
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
  if (deps.signal?.aborted) return
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
    !deps.signal?.aborted &&
    deps.dispatch({
      type: "NOTICE",
      message: `If the browser didn't open, visit:\n${url}`,
    })
  try {
    const result = await (deps.authenticate ?? defaultAuthenticate(deps))(server, onAuthUrl)
    if (result.ok) deps.probeCache?.clear(key)
    if (deps.signal?.aborted) return
    deps.dispatch({ type: "NOTICE", message: result.message })
  } catch (err) {
    if (deps.signal?.aborted) return
    deps.dispatch({
      type: "NOTICE",
      message: `Authorization failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

/** `/mcp logout <name>` — delete a server's stored OAuth credentials. */
export function mcpLogout(name: string, deps: McpDeps): void {
  const key = name.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /mcp logout <name>" })
    return
  }
  const removed = (deps.logout ?? ((n) => clearAuthEntry(deps.home, n)))(key)
  deps.probeCache?.clear(key)
  deps.dispatch({
    type: "NOTICE",
    message: removed
      ? `Signed out of "${key}" (cleared stored credentials).`
      : `No stored credentials for "${key}".`,
  })
}

/** `/mcp tools <name>` — connect to the server and list its advertised tools. */
export async function mcpTools(name: string, deps: McpDeps): Promise<void> {
  if (deps.signal?.aborted) return
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
    tools = await (deps.probe ?? defaultProbeTools(deps))(server)
  } catch (err) {
    if (deps.signal?.aborted) return
    const reason = err instanceof Error ? err.message : String(err)
    deps.dispatch({ type: "NOTICE", message: `Could not list tools for "${key}": ${reason}` })
    return
  }
  if (deps.signal?.aborted) return
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
  // The server's status changed — drop its cached probe so the next `/mcp` open
  // re-probes it rather than showing a stale badge.
  deps.probeCache?.clear(name)
  deps.dispatch({
    type: "NOTICE",
    message: `MCP server "${name}" ${disable ? "disabled" : "enabled"}.`,
  })
}

export function mcpSetEnabled(name: string, enabled: boolean, deps: McpDeps): void {
  ;(deps.setServerDisabled ?? ((n, d) => setDisabled(deps.home, n, d)))(name, !enabled)
  deps.probeCache?.clear(name)
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
    doc.mcpServers[name] = denormalizeMcpEntry(transport, config, {
      typeKey: transport === "stdio" ? null : "type",
    })
    nodeFs.mkdirSync(path.dirname(file), { recursive: true })
    nodeFs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8")
  }
}

/** Delete a server from the user's own `~/.cognia/mcp.json`. Returns false when
 * the file/entry is absent (so the caller can explain it lives elsewhere). */
function defaultRemoveServer(home: string) {
  return (name: string): boolean => {
    const file = path.join(home, "mcp.json")
    if (!nodeFs.existsSync(file)) return false
    let doc: { mcpServers?: Record<string, unknown> }
    try {
      doc = JSON.parse(nodeFs.readFileSync(file, "utf8"))
    } catch {
      return false
    }
    if (!doc.mcpServers || !(name in doc.mcpServers)) return false
    delete doc.mcpServers[name]
    nodeFs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8")
    return true
  }
}

/**
 * `/mcp remove <name>` — delete a server from the user's own `~/.cognia/mcp.json`
 * and re-open the panel. Servers contributed by a project `.mcp.json` or a plugin
 * aren't user-owned, so they're refused with a pointer to where they live.
 */
export async function mcpRemove(name: string, deps: McpDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const key = name.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /mcp remove <name>" })
    return
  }
  const removed = (deps.removeServer ?? defaultRemoveServer(deps.home))(key)
  if (removed) deps.probeCache?.clear(key)
  deps.dispatch({
    type: "NOTICE",
    message: removed
      ? `Removed MCP server "${key}". Re-add it any time with /mcp add.`
      : `"${key}" isn't in ~/.cognia/mcp.json — it likely comes from a project .mcp.json or a plugin; remove it there.`,
  })
  await mcpPanel(deps)
}

function loadCatalog(deps: McpDeps): Promise<CatalogPreset[]> {
  return (
    deps.collectPresets ?? (() => collectMcpPresets({ roots: deps.roots, home: deps.home }))
  )()
}

/** `/mcp presets` — browse the built-in + plugin-contributed preset gallery. */
export async function mcpPresets(deps: McpDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const catalog = await loadCatalog(deps)
  if (deps.signal?.aborted) return
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
  if (deps.signal?.aborted) return
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
  deps.probeCache?.clear(name)
  deps.dispatch({
    type: "NOTICE",
    message: `Added MCP server "${name}" from preset "${preset.id}" (${preset.transport}). Applies on the next turn.`,
  })
}

export async function mcpAdd(args: string, deps: McpDeps): Promise<void> {
  if (deps.signal?.aborted) return
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
  if (!["stdio", "sse", "http"].includes(transport)) {
    deps.dispatch({
      type: "NOTICE",
      message: "Unsupported MCP transport. Use stdio, sse, or http.",
    })
    return
  }
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
  deps.probeCache?.clear(name)
  deps.dispatch({
    type: "NOTICE",
    message: `Added MCP server "${name}" (${transport}). Applies on the next turn.`,
  })
}
