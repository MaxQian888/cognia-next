// Claude Desktop. Stdio-only on disk: remote servers are configured through
// the in-app Connectors UI and never appear in this file. We omit any
// `type` discriminator on serialize since Claude Desktop's parser doesn't
// expect one.
//
//   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
//   Windows: %APPDATA%\Claude\claude_desktop_config.json
//   Linux:   not officially supported

import type { McpServer } from "@cognia/agent-config-types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

interface RawDesktopConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawDesktopConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawDesktopConfig
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return []
  const out: McpImportDraft[] = []
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    // Claude Desktop is stdio-only; force the transport even if a stray
    // `url` is present (would have been ignored by Claude Desktop anyway).
    const norm = normalizeMcpEntry(raw, { forceTransport: "stdio" })
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
  const root: RawDesktopConfig = asRoot(existing) ?? {}
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name))
  const next: Record<string, unknown> = {}

  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value
    }
  }

  for (const server of servers) {
    if (server.transport !== "stdio") {
      // Claude Desktop's file format only supports stdio. Remote servers
      // would silently disappear if we wrote them; skip with a no-op so the
      // user can see the chip stays unchecked.
      continue
    }
    next[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      typeKey: null,
    })
  }

  return { ...root, mcpServers: next }
}

export const CLAUDE_DESKTOP_AGENT: McpAgentAdapter = {
  id: "claude-desktop",
  displayName: "Claude Desktop",
  description: "claude_desktop_config.json — stdio servers only",
  writable: true,
  format: "json",
  parse,
  project,
}
