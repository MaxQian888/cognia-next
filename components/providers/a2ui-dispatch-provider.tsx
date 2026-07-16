"use client"

/**
 * Subscribes once at app startup to the Tauri `a2ui://dispatch` event channel
 * so messages emitted by the standalone bridge (`sidecar/a2ui-mcp.mjs`,
 * spawned by external agents like Claude Code CLI) reach the A2UI Zustand
 * store. No-op outside Tauri — `subscribeA2UIDispatch` itself returns an
 * empty unlisten in web mode.
 *
 * Without this provider, dispatched A2UI messages emit to a Tauri event
 * channel that has no listeners, so external-agent surfaces never render.
 */

import { useEffect } from "react"
import { subscribeA2UIDispatch } from "@/lib/a2ui/ipc"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

export function A2UIDispatchProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    void subscribeA2UIDispatch().then((fn) => {
      if (cancelled) {
        safeUnlisten(fn)
      } else {
        unlisten = fn
      }
    })

    return () => {
      cancelled = true
      safeUnlisten(unlisten)
      unlisten = null
    }
  }, [])

  return <>{children}</>
}
