// Cognia CLI (`@cognia/agent-cli`). MCP servers live in the CLI home at
// `$COGNIA_HOME/mcp.json` (or `~/.cognia/mcp.json`), the user-scope file the
// CLI's loader reads first (see `cli/src/mcp/load-mcp-config.ts`).
//
// Format: `{ "mcpServers": { name: entry } }`. Unlike Claude Desktop, the CLI
// supports remote transports too (its `normalizeMcpEntry` accepts stdio AND
// sse/http), so we keep the `type` discriminator on serialize and never force
// a transport — this is the closest adapter to our own canonical shape.

import type { McpServer } from "@/lib/claude/types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

interface RawCogniaConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawCogniaConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawCogniaConfig
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
  // Preserve every unmanaged key (the file is MCP-only today, but keeping the
  // existing tree means a future CLI field survives a sync).
  const root: RawCogniaConfig = asRoot(existing) ?? {}
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

export const COGNIA_AGENT: McpAgentAdapter = {
  id: "cognia",
  displayName: "Cognia CLI",
  description: "~/.cognia/mcp.json — the standalone cognia-agent CLI",
  writable: true,
  format: "json",
  parse,
  project,
}
