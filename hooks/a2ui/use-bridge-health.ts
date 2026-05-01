// Diagnostic hook for the Settings → A2UI → MCP Bridge tab.
//
// Surfaces the runtime paths the bridge resolver needs (sidecar dir, socket
// path) plus the live surface count so the user can see at a glance whether
// the bridge is reachable, where the standalone MCP child will be spawned
// from, and how many surfaces are currently active.
//
// Outside Tauri (web preview), the runtime context returns null and the hook
// reports `isTauri: false` so the UI can render a "Tauri only" hint instead
// of misleading empty paths.

import { useEffect, useState } from "react"
import { isTauri } from "@/lib/tauri"
import { useA2UIStore } from "@/stores/a2ui"
import { getBuiltinMcpRuntimeContext } from "@/lib/claude/builtin-mcp/runtime-context"

export interface BridgeHealth {
  isTauri: boolean
  sidecarDir: string | null
  socketPath: string | null
  liveSurfaceCount: number
  /** Last error from `getBuiltinMcpRuntimeContext`, if any. Stable across renders until cleared. */
  error: string | null
  /** False on the first render before the IPC settles; true once the context fetch completes. */
  loaded: boolean
}

export function useBridgeHealth(): BridgeHealth {
  const liveSurfaceCount = useA2UIStore((s) => Object.keys(s.surfaces).length)
  const [paths, setPaths] = useState<{ sidecarDir: string; socketPath: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    getBuiltinMcpRuntimeContext()
      .then((ctx) => {
        if (cancelled) return
        setPaths(ctx)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return {
    isTauri: isTauri(),
    sidecarDir: paths?.sidecarDir ?? null,
    socketPath: paths?.socketPath ?? null,
    liveSurfaceCount,
    error,
    loaded,
  }
}
