// On Tauri, after a backup is restored, the Dexie `mcpServers` table is
// authoritative again — but the *projected* config files on disk
// (~/.config/Claude/claude_desktop_config.json, ~/.cursor/mcp.json, …) still
// reflect whatever the user had before the import. We re-emit each
// projection by calling `syncToAgent` for every known writable agent.
//
// Failures are captured per-agent and never bubble up: a single locked
// config file should not fail the whole restore.

import { isTauri } from "@/lib/tauri"
import type { AgentId } from "@cognia/agent-config-types"
import { syncToAgent, type SyncResult } from "@/lib/claude/sync"
import type { SyncProjectionReport } from "./types"

/** Order matters for UI display (matches `MCP_AGENT_ADAPTERS`). */
export const ALL_WRITABLE_AGENT_IDS: ReadonlyArray<AgentId> = [
  "cognia",
  "claude-code",
  "claude-desktop",
  "cursor",
  "vscode",
  "codex",
  "gemini",
  "windsurf",
]

/** Run `syncToAgent` for every writable agent in parallel, tolerating any
 * single-agent failure. Returns a report suitable for `ImportSummary`. */
export async function projectMcpToAllAgents(
  deps: {
    isTauri?: () => boolean
    syncToAgent?: (id: AgentId) => Promise<SyncResult>
    agentIds?: ReadonlyArray<AgentId>
  } = {}
): Promise<SyncProjectionReport[]> {
  const isTauriFn = deps.isTauri ?? isTauri
  const sync = deps.syncToAgent ?? syncToAgent
  const ids = deps.agentIds ?? ALL_WRITABLE_AGENT_IDS

  if (!isTauriFn()) {
    return ids.map((agentId) => ({
      agentId,
      ok: false,
      reason: "not-tauri",
    }))
  }

  const settled = await Promise.allSettled(ids.map((id) => sync(id)))
  return settled.map((entry, index) => {
    const agentId = ids[index] as AgentId
    if (entry.status === "rejected") {
      const reason = entry.reason
      return {
        agentId,
        ok: false,
        reason: reason instanceof Error ? reason.message : String(reason),
      }
    }
    return summarizeSyncResult(agentId, entry.value)
  })
}

export function summarizeSyncResult(agentId: AgentId, result: SyncResult): SyncProjectionReport {
  if (result.ok) {
    return { agentId, ok: true, count: result.count }
  }
  if ("skipped" in result && result.skipped) {
    return { agentId, ok: false, reason: result.reason }
  }
  return { agentId, ok: false, reason: result.error }
}
