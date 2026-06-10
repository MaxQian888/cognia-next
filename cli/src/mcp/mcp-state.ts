/**
 * Per-user enable/disable overlay for MCP servers, persisted to
 * `~/.cognia/mcp-state.json` as `{ "disabled": ["name", …] }`. The `.mcp.json`
 * files stay declarative (all-enabled); this is the mutable toggle layer that
 * `/mcp enable|disable` writes.
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

export function readDisabled(home: string, fs: McpStateFs = defaultFs): Set<string> {
  const file = mcpStatePath(home)
  if (!fs.exists(file)) return new Set()
  try {
    const parsed = JSON.parse(fs.readText(file)) as { disabled?: unknown }
    if (Array.isArray(parsed.disabled)) {
      return new Set(parsed.disabled.filter((n): n is string => typeof n === "string"))
    }
  } catch {
    // corrupt state → treat as empty
  }
  return new Set()
}

export function writeDisabled(
  home: string,
  disabled: Set<string>,
  fs: McpStateFs = defaultFs
): void {
  fs.writeText(mcpStatePath(home), JSON.stringify({ disabled: [...disabled] }, null, 2))
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

/** Apply the disabled overlay onto loaded servers (sets `enabled`). */
export function applyDisabled(servers: McpServer[], disabled: Set<string>): McpServer[] {
  return servers.map((s) => ({ ...s, enabled: !disabled.has(s.name) }))
}
