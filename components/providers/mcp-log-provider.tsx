"use client"

// Top-level provider that subscribes to the sidecar's per-MCP-server `mcp_log`
// events and forwards each into the unified logger (see
// `lib/mcp/log-bridge.ts`). Mount once in the app layout — without it, MCP
// server connect/error/stderr diagnostics never reach the GUI's log pipeline,
// so `<LogPanel sources={["mcp"]} />` (Settings → MCP → Health & Logs, and the
// `/logs` page) stays empty of outbound-server logs.
//
// Tauri-only. No-op on the plain web because `onClaudeMessage` requires the IPC
// listener which only exists inside the desktop / companion shell.

import { useEffect } from "react"

import { subscribeToMcpLogs } from "@/lib/mcp/log-bridge"
import { isTauri } from "@/lib/tauri"

export function McpLogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | null = null
    let cancelled = false

    void (async () => {
      try {
        const fn = await subscribeToMcpLogs()
        if (cancelled) {
          fn()
        } else {
          unlisten = fn
        }
      } catch (err) {
        // Listener registration only fails when the IPC bus is unavailable;
        // log + carry on so the rest of the app still renders.
        console.warn("mcp-log-provider: subscribe failed", err)
      }
    })()

    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

  return <>{children}</>
}
