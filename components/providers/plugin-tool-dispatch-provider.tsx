"use client"

/**
 * Global bridge: sidecar `plugin_tool_exec` events → `handlePluginToolExec` →
 * `claude_plugin_tool_response`. Subscribes ONCE at app layout (independent of
 * which chat session is focused — the round-trip is keyed by sessionId+toolUseId
 * on the sidecar), so plugin tools / ADR-0026 skills / terminal_dock / sandbox
 * tools resolve for direct chat, team, and background runs alike. No-op in web.
 *
 * Without this provider, every model call to a renderer-proxied tool hangs the
 * SDK turn forever (the sidecar awaits an unresolved promise). Mirrors
 * `A2UIDispatchProvider`.
 */

import { useEffect } from "react"

import { subscribePluginToolExec, sendPluginToolResponse } from "@/lib/claude/ipc"
import { handlePluginToolExec } from "@/lib/claude/plugin-tool-ipc"
import { loggers } from "@/lib/logging"

export function PluginToolDispatchProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    void subscribePluginToolExec((req) => {
      // handlePluginToolExec never throws (it collapses every failure onto the
      // response.error field); the write-back is the only thing that can.
      void handlePluginToolExec(req)
        .then((resp) => sendPluginToolResponse(resp))
        .catch((err) => {
          loggers.app.error("plugin_tool_response write failed", {
            toolUseId: req.toolUseId,
            error: String(err),
          })
        })
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })

    return () => {
      cancelled = true
      if (unlisten) {
        unlisten()
        unlisten = null
      }
    }
  }, [])

  return <>{children}</>
}
