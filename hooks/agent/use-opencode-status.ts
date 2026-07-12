"use client"

import { useCallback, useEffect, useState } from "react"

/** Normalized snapshot of a connected OpenCode server's status surfaces. */
export interface OpencodeStatus {
  /** Providers known to the server; `connected` marks authenticated ones. */
  providers: Array<{ id: string; name?: string; connected: boolean }>
  /** Agents (modes) the server exposes. */
  agents: Array<{ id: string; name?: string; description?: string }>
  /** Slash commands the server exposes. */
  commands: Array<{ name: string; description?: string }>
  /** MCP servers by name with their connection state. */
  mcpServers: Array<{ name: string; status?: string }>
  /** LSP servers by id with their state. */
  lspServers: Array<{ id: string; status?: string }>
  /** Current project info (worktree path, VCS kind) when available. */
  project?: { worktree?: string; vcs?: string }
}

const EMPTY_STATUS: OpencodeStatus = {
  providers: [],
  agents: [],
  commands: [],
  mcpServers: [],
  lspServers: [],
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Map `{ name: state }` status payloads (MCP / LSP) into badge rows. */
function statusEntries(value: unknown): Array<{ name: string; status?: string }> {
  const record = asRecord(value)
  if (!record) return []
  return Object.entries(record).map(([name, state]) => {
    const stateRecord = asRecord(state)
    const status =
      typeof stateRecord?.status === "string"
        ? stateRecord.status
        : typeof stateRecord?.state === "string"
          ? stateRecord.state
          : undefined
    return { name, status }
  })
}

/**
 * Pull the status surfaces of a connected OpenCode agent (providers, agents,
 * commands, MCP/LSP servers, project) through the manager's
 * `getOpenCodeAdapter` escape hatch. Read-only with a manual refresh —
 * the OpenCode analog of {@link useCodexAppServerStatus}.
 */
export function useOpencodeStatus(
  agentId: string,
  connected: boolean
): {
  status: OpencodeStatus
  loading: boolean
  available: boolean
  refresh: () => Promise<void>
} {
  const [status, setStatus] = useState<OpencodeStatus>(EMPTY_STATUS)
  const [loading, setLoading] = useState(false)
  const [available, setAvailable] = useState(false)

  const refresh = useCallback(async () => {
    if (!connected) return
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    const adapter = getExternalAgentManager().getOpenCodeAdapter(agentId)
    if (!adapter) return
    setLoading(true)
    try {
      // Live calls are independent and individually optional — a server
      // without LSP or a project must not blank the rest of the card.
      const [mcp, lsp, project] = await Promise.allSettled([
        adapter.getMcpStatus(),
        adapter.getLspStatus(),
        adapter.getProject(),
      ])
      const providerInfo = adapter.getProviders()
      const connectedIds = new Set(providerInfo?.connected ?? [])
      const projectRecord = project.status === "fulfilled" ? asRecord(project.value) : undefined
      const vcsRaw = projectRecord?.vcs
      setStatus({
        providers: (providerInfo?.all ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          connected: connectedIds.has(p.id),
        })),
        agents: adapter.getAvailableAgents(),
        commands: adapter.getAvailableCommands().map((c) => ({
          name: c.name,
          description: c.description || undefined,
        })),
        mcpServers: mcp.status === "fulfilled" ? statusEntries(mcp.value) : [],
        lspServers:
          lsp.status === "fulfilled"
            ? statusEntries(lsp.value).map(({ name, status }) => ({ id: name, status }))
            : [],
        project: projectRecord
          ? {
              worktree:
                typeof projectRecord.worktree === "string" ? projectRecord.worktree : undefined,
              vcs: typeof vcsRaw === "string" ? vcsRaw : undefined,
            }
          : undefined,
      })
    } finally {
      setLoading(false)
    }
  }, [agentId, connected])

  useEffect(() => {
    let active = true
    void (async () => {
      if (!connected) {
        if (active) {
          setStatus(EMPTY_STATUS)
          setAvailable(false)
        }
        return
      }
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      const adapter = getExternalAgentManager().getOpenCodeAdapter(agentId)
      if (!adapter || !active) return
      setAvailable(true)
      void refresh()
    })()
    return () => {
      active = false
    }
  }, [agentId, connected, refresh])

  return { status, loading, available, refresh }
}
