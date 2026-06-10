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
import type { TuiAction } from "../state/types"

export interface McpDeps {
  dispatch: (action: TuiAction) => void
  roots: string[]
  home: string
  load?: () => McpServer[]
  setServerDisabled?: (name: string, disabled: boolean) => void
  addServer?: (name: string, transport: McpTransport, config: Record<string, unknown>) => void
}

function loadServers(deps: McpDeps): McpServer[] {
  if (deps.load) return deps.load()
  return applyDisabled(loadMcpServers(deps.roots), readDisabled(deps.home))
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

export function mcpList(deps: McpDeps): void {
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
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "MCP servers (Enter toggles enable)",
      items: servers.map((s) => ({
        id: s.name,
        label: s.name,
        hint: `${s.transport} · ${s.enabled ? "on" : "off"}`,
      })),
      index: 0,
      onSelectCommand: "mcp toggle",
    },
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

export function mcpAdd(args: string, deps: McpDeps): void {
  const flags = parseFlags(args)
  const name = flags.name?.trim()
  if (!name) {
    deps.dispatch({
      type: "NOTICE",
      message: "Usage: /mcp add --name <n> --transport stdio --command <cmd> | --url <url>",
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
