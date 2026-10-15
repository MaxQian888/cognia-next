"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

/** Normalized snapshot of a connected OpenCode server's status surfaces. */
export interface OpencodeStatus {
  /** Providers known to the server; `connected` marks authenticated ones. */
  providers: Array<{ id: string; name?: string; connected?: boolean }>
  /** Agents (modes) the server exposes. */
  agents: Array<{ id: string; name?: string; description?: string }>
  /** Slash commands the server exposes. */
  commands: Array<{ name: string; description?: string }>
  /** MCP servers by name with their connection state. */
  mcpServers: Array<{ name: string; status?: string }>
  /** LSP servers by id with their state. */
  lspServers: Array<{ id: string; status?: string }>
  /** Unknown and failed reads must never be presented as empty results. */
  surfaces?: Partial<
    Record<
      "providers" | "providerAuth" | "agents" | "commands" | "mcp" | "lsp" | "project",
      "loading" | "ready" | "error" | "unsupported"
    >
  >
  /** Current project info (worktree path, VCS kind) when available. */
  project?: { worktree?: string; vcs?: string }
}

const EMPTY_STATUS: OpencodeStatus = {
  providers: [],
  agents: [],
  commands: [],
  mcpServers: [],
  lspServers: [],
  surfaces: {
    providers: "loading",
    agents: "loading",
    commands: "loading",
    mcp: "loading",
    lsp: "loading",
    project: "loading",
  },
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

/** Read status from either OpenCode API without treating failed reads as empty. */
export function useOpencodeStatus(
  agentId: string,
  connected: boolean
): {
  status: OpencodeStatus
  loading: boolean
  available: boolean
  refresh: () => Promise<void>
} {
  const request = useMemo(() => ({ agentId, connected }), [agentId, connected])
  const [snapshot, setSnapshot] = useState<{
    request: typeof request | null
    status: OpencodeStatus
    loading: boolean
    available: boolean
  }>({ request: null, status: EMPTY_STATUS, loading: false, available: false })
  const issued = useRef(0)

  const refresh = useCallback(async () => {
    if (!connected) return
    const ticket = ++issued.current
    const publish = (
      update: Partial<Pick<typeof snapshot, "status" | "loading" | "available">>
    ) => {
      if (issued.current !== ticket) return
      setSnapshot((previous) => ({
        ...(previous.request === request
          ? previous
          : { request, status: EMPTY_STATUS, loading: false, available: false }),
        ...update,
      }))
    }
    publish({ loading: true })
    try {
      const [{ getExternalAgentManager }, { openCodeServerExtension }, { openCodeV2Extension }] =
        await Promise.all([
          import("@/lib/ai/agent/external/manager"),
          import("@cognia/agent-opencode/client"),
          import("@cognia/agent-opencode/v2-client"),
        ])
      if (issued.current !== ticket) return
      const manager = getExternalAgentManager()
      const adapter = manager.getAdapterExtension(agentId, openCodeServerExtension)
      const v2 = adapter ? undefined : manager.getAdapterExtension(agentId, openCodeV2Extension)
      publish({ available: !!(adapter || v2) })
      if (v2) {
        const client = v2.getSdkClient()
        const directory = manager.getAgent(agentId)?.config.process?.cwd
        const input = directory ? { location: { directory } } : undefined
        const [providers, integrations, agents, commands, mcp, project] = await Promise.allSettled([
          client.provider.list(input),
          client.integration.list(input),
          client.agent.list(input),
          client.command.list(input),
          client.mcp.list(input),
          client.location.get(input),
        ])
        if (issued.current !== ticket) return
        publish({
          status: {
            providers:
              providers.status === "fulfilled"
                ? providers.value.data.map(({ id, name, integrationID }) => {
                    const integration =
                      integrations.status === "fulfilled"
                        ? integrations.value.data.find((item) => item.id === integrationID)
                        : undefined
                    return {
                      id,
                      name,
                      connected: integration
                        ? integration.connections.some((connection) => !connection.status)
                        : undefined,
                    }
                  })
                : [],
            agents: agents.status === "fulfilled" ? agents.value.data : [],
            commands: commands.status === "fulfilled" ? commands.value.data : [],
            mcpServers:
              mcp.status === "fulfilled"
                ? mcp.value.data.map(({ name, status }) => ({ name, status: status.status }))
                : [],
            lspServers: [],
            project:
              project.status === "fulfilled" ? { worktree: project.value.directory } : undefined,
            surfaces: {
              providers: providers.status === "fulfilled" ? "ready" : "error",
              providerAuth: integrations.status === "fulfilled" ? "ready" : "error",
              agents: agents.status === "fulfilled" ? "ready" : "error",
              commands: commands.status === "fulfilled" ? "ready" : "error",
              mcp: mcp.status === "fulfilled" ? "ready" : "error",
              project: project.status === "fulfilled" ? "ready" : "error",
              lsp: "unsupported",
            },
          },
        })
      } else if (adapter) {
        const [mcp, lsp, project] = await Promise.allSettled([
          adapter.getMcpStatus(),
          adapter.getLspStatus(),
          adapter.getProject(),
        ])
        if (issued.current !== ticket) return
        const providerInfo = adapter.getProviders()
        const connectedIds = new Set(providerInfo?.connected ?? [])
        const projectRecord = project.status === "fulfilled" ? asRecord(project.value) : undefined
        publish({
          status: {
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
                ? Array.isArray(lsp.value)
                  ? lsp.value.map((server) => ({ id: server.id, status: server.status }))
                  : statusEntries(lsp.value).map(({ name, status }) => ({ id: name, status }))
                : [],
            project: projectRecord
              ? {
                  worktree:
                    typeof projectRecord.worktree === "string" ? projectRecord.worktree : undefined,
                  vcs: typeof projectRecord.vcs === "string" ? projectRecord.vcs : undefined,
                }
              : undefined,
            surfaces: {
              providers: "ready",
              agents: "ready",
              commands: "ready",
              mcp: mcp.status === "fulfilled" ? "ready" : "error",
              lsp: lsp.status === "fulfilled" ? "ready" : "error",
              project: project.status === "fulfilled" ? "ready" : "error",
            },
          },
        })
      }
    } catch {
      if (issued.current === ticket) {
        publish({
          status: {
            ...EMPTY_STATUS,
            surfaces: {
              providers: "error",
              agents: "error",
              commands: "error",
              mcp: "error",
              lsp: "error",
              project: "error",
            },
          },
        })
      }
    } finally {
      publish({ loading: false })
    }
  }, [agentId, connected, request])

  useEffect(() => {
    void refresh()
    return () => {
      issued.current += 1
    }
  }, [refresh])

  const current = connected && snapshot.request === request
  return {
    status: current ? snapshot.status : EMPTY_STATUS,
    loading: connected && (!current || snapshot.loading),
    available: current && snapshot.available,
    refresh,
  }
}
