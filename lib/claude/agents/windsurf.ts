// Windsurf (Codeium). ~/.codeium/windsurf/mcp_config.json. Quirk: remote
// servers use `serverUrl` instead of `url`. We canonicalize to `url` on read
// (via `normalizeMcpEntry({ urlKey: "serverUrl" })`) and re-stamp it back to
// `serverUrl` on write.

import type { McpServer } from "@/lib/claude/types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

interface RawWindsurfConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawWindsurfConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawWindsurfConfig
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return []
  const out: McpImportDraft[] = []
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    const norm = normalizeMcpEntry(raw, { urlKey: "serverUrl" })
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
  const root: RawWindsurfConfig = asRoot(existing) ?? {}
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name))
  const next: Record<string, unknown> = {}

  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value
    }
  }

  for (const server of servers) {
    next[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      // Windsurf doesn't use a `type` discriminator at all; transport is
      // inferred from `command` vs `serverUrl`.
      typeKey: null,
      urlKey: "serverUrl",
    })
  }

  return { ...root, mcpServers: next }
}

export const WINDSURF_AGENT: McpAgentAdapter = {
  id: "windsurf",
  displayName: "Windsurf",
  description: "~/.codeium/windsurf/mcp_config.json — uses `serverUrl`",
  writable: true,
  format: "json",
  parse,
  project,
}
