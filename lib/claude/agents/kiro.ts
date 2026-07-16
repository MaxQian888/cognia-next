// Kiro (AWS). User scope lives at ~/.kiro/settings/mcp.json; the workspace
// file (.kiro/settings/mcp.json) takes precedence but is out of scope for the
// user-scope sync. Two quirks worth flagging:
//   1. No `type` discriminator — Kiro tells local from remote structurally
//      (`command` => stdio, `url` => http), same as Zed.
//   2. Entries carry Kiro-only lifecycle keys (`disabled`, `autoApprove`,
//      `disabledTools`). We strip those on parse so they never leak into a
//      different agent's file, and leave Kiro's own entries untouched.
//
// Format docs: https://kiro.dev/docs/mcp/configuration/

import type { McpServer } from "@cognia/agent-config-types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

/** Kiro-only keys that must not ride along into our canonical config. */
const KIRO_ONLY_KEYS = ["disabled", "autoApprove", "disabledTools"] as const

interface RawKiroConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawKiroConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawKiroConfig
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return []
  const out: McpImportDraft[] = []
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    if (!raw || typeof raw !== "object") continue
    const entry = { ...(raw as Record<string, unknown>) }
    for (const key of KIRO_ONLY_KEYS) delete entry[key]
    const norm = normalizeMcpEntry(entry)
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
  const root: RawKiroConfig = asRoot(existing) ?? {}
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name))
  const next: Record<string, unknown> = {}

  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value
    }
  }

  for (const server of servers) {
    // Preserve Kiro's own lifecycle keys on a server we already manage, so a
    // sync doesn't silently re-enable something the user disabled in Kiro.
    const prior = (root.mcpServers as Record<string, unknown> | undefined)?.[server.name]
    const carried: Record<string, unknown> = {}
    if (prior && typeof prior === "object") {
      for (const key of KIRO_ONLY_KEYS) {
        const value = (prior as Record<string, unknown>)[key]
        if (value !== undefined) carried[key] = value
      }
    }
    next[server.name] = {
      ...denormalizeMcpEntry(server.transport, server.config, { typeKey: null }),
      ...carried,
    }
  }

  return { ...root, mcpServers: next }
}

export const KIRO_AGENT: McpAgentAdapter = {
  id: "kiro",
  displayName: "Kiro",
  description: "~/.kiro/settings/mcp.json — no `type` key, local vs remote inferred",
  writable: true,
  format: "json",
  parse,
  project,
}
