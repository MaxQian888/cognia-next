// Cursor. ~/.cursor/mcp.json (global). Project-scope `.cursor/mcp.json` is
// out of scope for the multi-agent sync — cognia-next isn't project-aware
// and the user can still import from one via the manual import dialog if we
// expose that later. Cursor accepts stdio (`type: "stdio"`) and remote
// (`url`, optional `headers` / `auth`); when `type` is omitted on a remote
// entry, Cursor auto-detects SSE vs HTTP from the response. We collapse to
// `http` for our representation.

import type { McpServer } from "@/lib/claude/types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

interface RawCursorConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawCursorConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawCursorConfig
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return []
  const out: McpImportDraft[] = []
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    const norm = normalizeMcpEntry(raw)
    if (!norm) continue
    out.push({ name, transport: norm.transport, config: norm.config })
  }
  return dropInvalidDrafts(out)
}

function project(
  existing: unknown | null,
  servers: McpServer[],
  managedNames?: ReadonlySet<string>
): unknown {
  const root: RawCursorConfig = asRoot(existing) ?? {}
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name))
  const next: Record<string, unknown> = {}

  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value
    }
  }

  for (const server of servers) {
    next[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      typeKey: "type",
    })
  }

  return { ...root, mcpServers: next }
}

export const CURSOR_AGENT: McpAgentAdapter = {
  id: "cursor",
  displayName: "Cursor",
  description: "~/.cursor/mcp.json — global Cursor MCP config",
  writable: true,
  format: "json",
  parse,
  project,
}
