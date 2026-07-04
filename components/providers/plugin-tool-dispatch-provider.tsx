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

import {
  subscribePluginToolExec,
  sendPluginToolResponse,
  subscribeProtocolAdapterExec,
  subscribeProtocolAdapterCancel,
  sendProtocolAdapterMessage,
} from "@/lib/claude/ipc"
import { handlePluginToolExec } from "@/lib/claude/plugin-tool-ipc"
import { dispatchProtocolAdapterExec } from "@/lib/claude/protocol-adapter-ipc"
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

  // P2-E: code-level protocol adapters round-trip through the renderer — the
  // plugin's executor runs HERE (never in the sidecar) and streams chunks back.
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null
    const executions = new Map<string, ReturnType<typeof dispatchProtocolAdapterExec>>()

    void subscribeProtocolAdapterExec((req) => {
      const handle = dispatchProtocolAdapterExec(req, { writeCommand: sendProtocolAdapterMessage })
      executions.set(`${req.sessionId}:${req.execId}`, handle)
      void handle.done
        .catch((err) => {
          loggers.app.error("protocol_adapter dispatch failed", {
            execId: req.execId,
            error: String(err),
          })
        })
        .finally(() => {
          executions.delete(`${req.sessionId}:${req.execId}`)
        })
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })

    let cancelUnlisten: (() => void) | null = null
    void subscribeProtocolAdapterCancel((req) => {
      executions.get(`${req.sessionId}:${req.execId}`)?.cancel(req.reason)
    }).then((fn) => {
      if (cancelled) fn()
      else cancelUnlisten = fn
    })

    return () => {
      cancelled = true
      for (const handle of executions.values()) handle.cancel("renderer unmounted")
      executions.clear()
      if (unlisten) {
        unlisten()
        unlisten = null
      }
      if (cancelUnlisten) {
        cancelUnlisten()
        cancelUnlisten = null
      }
    }
  }, [])

  return <>{children}</>
}
