"use client"

import { useCallback, useEffect, useState } from "react"
import type { CodexAppServerStatus } from "@/lib/ai/agent/external/codex-app-server-client"

const EMPTY_STATUS: CodexAppServerStatus = { mcpServers: [], skills: [] }

/**
 * Subscribe to the native Codex `app-server` status (configured MCP servers +
 * skills) for a connected external agent. Read-only: it pulls the current
 * snapshot on mount, subscribes to live updates, and exposes a manual refresh.
 *
 * Returns the empty snapshot whenever the agent isn't connected through the
 * app-server protocol (e.g. it uses the ACP shim, or isn't connected yet).
 */
export function useCodexAppServerStatus(
  agentId: string,
  connected: boolean
): {
  status: CodexAppServerStatus
  loading: boolean
  available: boolean
  refresh: () => Promise<void>
} {
  const [status, setStatus] = useState<CodexAppServerStatus>(EMPTY_STATUS)
  const [loading, setLoading] = useState(false)
  const [available, setAvailable] = useState(false)

  const refresh = useCallback(async () => {
    if (!connected) return
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    const adapter = getExternalAgentManager().getCodexAppServerAdapter(agentId)
    if (!adapter) return
    setLoading(true)
    try {
      const [mcpServers, skills] = await Promise.all([
        adapter.refreshMcpServers(),
        adapter.refreshSkills(),
      ])
      setStatus({ mcpServers, skills })
    } finally {
      setLoading(false)
    }
  }, [agentId, connected])

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined
    void (async () => {
      if (!connected) {
        if (active) {
          setStatus(EMPTY_STATUS)
          setAvailable(false)
        }
        return
      }
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      const adapter = getExternalAgentManager().getCodexAppServerAdapter(agentId)
      if (!adapter || !active) return
      setAvailable(true)
      setStatus(adapter.getStatus())
      unsubscribe = adapter.onStatusUpdate((next) => {
        if (active) setStatus(next)
      })
      void refresh()
    })()
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [agentId, connected, refresh])

  return { status, loading, available, refresh }
}
