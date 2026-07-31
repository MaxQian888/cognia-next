// VS Code (GitHub Copilot Chat). Two quirks worth flagging up-front:
//   1. Top-level key is `servers`, not `mcpServers`.
//   2. The on-disk file is JSONC (allows `//` comments and trailing commas).
//      Comments are stripped on parse and won't survive a write — this is
//      documented to users in the import dialog.
//
// Format docs: https://code.visualstudio.com/docs/copilot/customization/mcp-servers

import type { McpServer } from "@cognia/agent-config-types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

interface RawVsCodeConfig {
  servers?: Record<string, unknown>
  inputs?: unknown[]
  [key: string]: unknown
}

function asRoot(value: unknown): RawVsCodeConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawVsCodeConfig
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root?.servers || typeof root.servers !== "object") return []
  const out: McpImportDraft[] = []
  for (const [name, raw] of Object.entries(root.servers)) {
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
  const root: RawVsCodeConfig = asRoot(existing) ?? {}
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name))
  const next: Record<string, unknown> = {}

  if (root.servers && typeof root.servers === "object") {
    for (const [name, value] of Object.entries(root.servers)) {
      if (!managedSet.has(name)) next[name] = value
    }
  }

  for (const server of servers) {
    next[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      typeKey: "type",
    })
  }

  return { ...root, servers: next }
}

export const VSCODE_AGENT: McpAgentAdapter = {
  id: "vscode",
  displayName: "VS Code (Copilot)",
  description: "User mcp.json — top-level key `servers`, JSONC",
  writable: true,
  format: "jsonc",
  parse,
  project,
}
