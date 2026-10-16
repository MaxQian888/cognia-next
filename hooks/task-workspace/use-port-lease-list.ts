"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { hasHostRuntime } from "@/lib/platform/capabilities"
import { listWorkspacePortLeases } from "@/lib/task-workspace/client"
import type { WorkspacePortLeaseList } from "@/lib/task-workspace/types"

/** Browser-only mode is deliberately inert: reads require a desktop or connected host. */
export interface PortLeaseListState {
  status: "inert" | "loading" | "ready" | "error"
  data: WorkspacePortLeaseList | null
  error: string | null
}

/** Inventory reads only; opening Settings must never allocate a port block. */
export function usePortLeaseList({
  enabled = true,
  refreshKey,
}: { enabled?: boolean; refreshKey?: unknown } = {}) {
  const hostAvailable = hasHostRuntime()
  const generation = useRef(0)
  const [state, setState] = useState<PortLeaseListState>({
    status: hostAvailable ? "loading" : "inert",
    data: null,
    error: null,
  })
  const refresh = useCallback(async () => {
    const request = ++generation.current
    if (!hostAvailable || !enabled) {
      setState({ status: "inert", data: null, error: null })
      return
    }
    setState((current) => ({ ...current, status: "loading", error: null }))
    try {
      const data = await listWorkspacePortLeases()
      if (request === generation.current) {
        setState({ status: "ready", data, error: null })
      }
    } catch (cause) {
      if (request === generation.current) {
        setState((current) => ({
          ...current,
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        }))
      }
    }
  }, [hostAvailable, enabled])

  useEffect(() => {
    void refresh()
    return () => {
      generation.current += 1
    }
  }, [refresh, refreshKey])

  return { ...state, refresh }
}
