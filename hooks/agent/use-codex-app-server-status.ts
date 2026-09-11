"use client"

import { useCallback, useEffect, useRef, useState } from "react"
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
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    if (!connected) return
    const requestGeneration = generation.current
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    if (generation.current !== requestGeneration) return
    const adapter = getExternalAgentManager().getCodexAppServerAdapter(agentId)
    if (!adapter) return
    setLoading(true)
    try {
      // refreshAccount folds account + rate limits into the adapter status;
      // read the merged snapshot afterwards so all sections stay coherent.
      await Promise.all([
        adapter.refreshMcpServers(),
        adapter.refreshSkills(),
        adapter.refreshAccount(),
      ])
      if (generation.current === requestGeneration) setStatus(adapter.getStatus())
    } finally {
      if (generation.current === requestGeneration) setLoading(false)
    }
  }, [agentId, connected])

  useEffect(() => {
    generation.current += 1
    let active = true
    let unsubscribe: (() => void) | undefined
    void (async () => {
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      if (!active) return
      setStatus(EMPTY_STATUS)
      setAvailable(false)
      setLoading(false)
      if (!connected) {
        return
      }
      const adapter = getExternalAgentManager().getCodexAppServerAdapter(agentId)
      if (!adapter || !active) return
      setAvailable(true)
      setStatus(adapter.getStatus())
      unsubscribe = adapter.onStatusUpdate((next) => {
        if (active) setStatus(next)
      })
      // MCP inventory discovery launches processes in Codex. Mounting a status
      // card must only subscribe to those already reported by the server;
      // discovering tools remains an explicit refresh action.
      setLoading(true)
      try {
        await Promise.all([adapter.refreshAccount(), adapter.refreshSkills()])
        if (active) setStatus(adapter.getStatus())
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      generation.current += 1
      active = false
      unsubscribe?.()
    }
  }, [agentId, connected, refresh])

  return { status, loading, available, refresh }
}
