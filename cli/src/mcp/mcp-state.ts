/**
 * Per-user enable/disable overlay for MCP servers, persisted to
 * `~/.cognia/mcp-state.json` as `{ "disabled": ["name", …], "disabledTools":
 * ["mcp__server__tool", …] }`. The `.mcp.json` files stay declarative
 * (all-enabled); this is the mutable toggle layer that `/mcp enable|disable`
 * (server level) and the `/mcp` panel's per-tool toggles write. The disabled
 * tool names are the gate's namespaced form, threaded into the SDK's
 * `disallowedTools` by `session-runner` so the model never sees them.
 */
import nodeFs from "node:fs"
import path from "node:path"

import type { McpServer } from "@/lib/claude/types"

export interface McpStateFs {
  exists(path: string): boolean
  readText(path: string): string
  writeText(path: string, data: string): void
}

const defaultFs: McpStateFs = {
  exists: (p) => nodeFs.existsSync(p),
  readText: (p) => nodeFs.readFileSync(p, "utf8"),
  writeText: (p, data) => {
    nodeFs.mkdirSync(path.dirname(p), { recursive: true })
    nodeFs.writeFileSync(p, data, "utf8")
  },
}

export function mcpStatePath(home: string): string {
  return path.join(home, "mcp-state.json")
}

interface McpStateDoc {
  disabled: Set<string>
  disabledTools: Set<string>
}

function toStringSet(value: unknown): Set<string> {
  return Array.isArray(value)
    ? new Set(value.filter((n): n is string => typeof n === "string"))
    : new Set()
}

/** Read the full overlay (servers + tools). Corrupt state → both empty. */
function readState(home: string, fs: McpStateFs = defaultFs): McpStateDoc {
  const file = mcpStatePath(home)
  if (!fs.exists(file)) return { disabled: new Set(), disabledTools: new Set() }
  try {
    const parsed = JSON.parse(fs.readText(file)) as { disabled?: unknown; disabledTools?: unknown }
    return {
      disabled: toStringSet(parsed.disabled),
      disabledTools: toStringSet(parsed.disabledTools),
    }
  } catch {
    return { disabled: new Set(), disabledTools: new Set() }
  }
}

function writeState(home: string, doc: McpStateDoc, fs: McpStateFs = defaultFs): void {
  fs.writeText(
    mcpStatePath(home),
    JSON.stringify({ disabled: [...doc.disabled], disabledTools: [...doc.disabledTools] }, null, 2)
  )
}

export function readDisabled(home: string, fs: McpStateFs = defaultFs): Set<string> {
  return readState(home, fs).disabled
}

export function writeDisabled(
  home: string,
  disabled: Set<string>,
  fs: McpStateFs = defaultFs
): void {
  // Preserve any per-tool overlay when only the server set changes.
  writeState(home, { ...readState(home, fs), disabled }, fs)
}

/** Flip a server's disabled state and persist. Returns the new disabled set. */
export function setDisabled(
  home: string,
  name: string,
  disabled: boolean,
  fs: McpStateFs = defaultFs
): Set<string> {
  const set = readDisabled(home, fs)
  if (disabled) set.add(name)
  else set.delete(name)
  writeDisabled(home, set, fs)
  return set
}

/** The disabled per-tool overlay: namespaced `mcp__server__tool` names. */
export function readDisabledTools(home: string, fs: McpStateFs = defaultFs): Set<string> {
  return readState(home, fs).disabledTools
}

/** Flip one tool's disabled state and persist. Returns the new disabled-tool set. */
export function setDisabledTool(
  home: string,
  toolName: string,
  disabled: boolean,
  fs: McpStateFs = defaultFs
): Set<string> {
  const doc = readState(home, fs)
  if (disabled) doc.disabledTools.add(toolName)
  else doc.disabledTools.delete(toolName)
  writeState(home, doc, fs)
  return doc.disabledTools
}

/** Apply the disabled overlay onto loaded servers (sets `enabled`). */
export function applyDisabled(servers: McpServer[], disabled: Set<string>): McpServer[] {
  return servers.map((s) => ({ ...s, enabled: !disabled.has(s.name) }))
}

/** The gate's namespaced form for an MCP server's tool (matches `disallowedTools`). */
export function mcpToolGateName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}
