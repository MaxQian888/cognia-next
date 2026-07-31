// Claude Code (~/.claude.json). Reads from BOTH the root-level mcpServers
// (user scope) and every projects[absPath].mcpServers (local scope) — that
// way users importing from a machine they've used Claude Code on for a while
// get every server they care about without having to know which scope each
// one ended up in. Projection only writes to the root scope; the per-project
// scope stays untouched, since cognia-next isn't project-aware.

import type { McpServer } from "@cognia/agent-config-types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

interface RawClaudeConfig {
  mcpServers?: Record<string, unknown>
  projects?: Record<string, { mcpServers?: Record<string, unknown> } | unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawClaudeConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawClaudeConfig
}

function entriesFromMap(map: Record<string, unknown>): McpImportDraft[] {
  const out: McpImportDraft[] = []
  for (const [name, value] of Object.entries(map)) {
    const norm = normalizeMcpEntry(value)
    if (!norm) continue
    out.push({ name, transport: norm.transport, config: norm.config })
  }
  return out
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root) return []

  const seen = new Map<string, McpImportDraft>()

  // Root scope wins on collision — that's where `claude mcp add --scope user`
  // writes.
  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const draft of entriesFromMap(root.mcpServers)) {
      seen.set(draft.name, draft)
    }
  }

  if (root.projects && typeof root.projects === "object") {
    for (const project of Object.values(root.projects)) {
      if (!project || typeof project !== "object") continue
      const map = (project as { mcpServers?: unknown }).mcpServers
      if (!map || typeof map !== "object") continue
      for (const draft of entriesFromMap(map as Record<string, unknown>)) {
        if (!seen.has(draft.name)) seen.set(draft.name, draft)
      }
    }
  }

  return dropInvalidDrafts(Array.from(seen.values()))
}

function project(
  existing: unknown | null,
  servers: McpServer[],
  managedNames?: ReadonlySet<string>
): unknown {
  // Start from the existing tree so every unrelated key (auth, telemetry,
  // projects[*], etc.) is preserved verbatim.
  const root: RawClaudeConfig = asRoot(existing) ?? {}
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

export const CLAUDE_CODE_AGENT: McpAgentAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  description: "~/.claude.json — root mcpServers + projects[].mcpServers",
  writable: true,
  format: "json",
  parse,
  project,
}
