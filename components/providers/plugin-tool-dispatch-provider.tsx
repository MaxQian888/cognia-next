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
  subscribePluginHookExec,
  sendPluginHookResponse,
  subscribeProtocolAdapterExec,
  subscribeProtocolAdapterCancel,
  sendProtocolAdapterMessage,
} from "@/lib/claude/ipc"
import { dispatchProtocolAdapterExec } from "@/lib/claude/protocol-adapter-ipc"
import { activeHostSupportsFeature } from "@/stores/remote-host/remote-host-store"
import { loggers } from "@cognia/logging"

export function PluginToolDispatchProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    void subscribePluginToolExec((req) => {
      if (
        req.remoteExecutionContext &&
        !activeHostSupportsFeature("claude.controller-tool-proxy", "plugin_tool_exec")
      ) {
        void sendPluginToolResponse(
          {
            type: "plugin_tool_response",
            sessionId: req.sessionId,
            toolUseId: req.toolUseId,
            error: "REMOTE_FEATURE_UNSUPPORTED: controller tool proxy is not advertised",
          },
          req.remoteExecutionContext
        ).catch((error) => {
          loggers.app.error("unsupported remote plugin response failed", {
            toolUseId: req.toolUseId,
            error: String(error),
          })
        })
        return
      }
      // handlePluginToolExec never throws (it collapses every failure onto the
      // response.error field); the write-back is the only thing that can.
      void import("@/lib/claude/plugin-tool-ipc")
        .then(({ handlePluginToolExec }) => handlePluginToolExec(req))
        .then((resp) =>
          req.remoteExecutionContext
            ? sendPluginToolResponse(resp, req.remoteExecutionContext)
            : sendPluginToolResponse(resp)
        )
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

  // Settings.json `{ type: "plugin" }` lifecycle hooks round-trip the same way
  // plugin tools do. Mounted here rather than per-session because the sidecar
  // keys the round-trip by sessionId+execId, so one subscription serves direct
  // chat, teams and background runs alike.
  //
  // Without this, a configured plugin hook simply times out after 5s and fails
  // OPEN with a warning — never a block. That is deliberate, but it means the
  // hook silently does nothing, so this provider is load-bearing.
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    void subscribePluginHookExec((req) => {
      // handlePluginHookExec never throws (every failure collapses onto
      // `error`); only the write-back can.
      void import("@/lib/claude/plugin-hook-ipc")
        .then(({ handlePluginHookExec }) => handlePluginHookExec(req))
        .then((outcome) =>
          sendPluginHookResponse({
            sessionId: req.sessionId,
            execId: req.execId,
            ...(outcome.result !== undefined ? { result: outcome.result } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
          })
        )
        .catch((err) => {
          loggers.app.error("plugin_hook_response write failed", {
            execId: req.execId,
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
      if (
        req.remoteExecutionContext &&
        !activeHostSupportsFeature("claude.controller-tool-proxy", "protocol_adapter_exec")
      ) {
        void sendProtocolAdapterMessage(
          {
            type: "protocol_adapter_error",
            sessionId: req.sessionId,
            execId: req.execId,
            error: "REMOTE_FEATURE_UNSUPPORTED: protocol adapter proxy is not advertised",
          },
          req.remoteExecutionContext
        ).catch((error) => {
          loggers.app.error("unsupported remote protocol adapter response failed", {
            execId: req.execId,
            error: String(error),
          })
        })
        return
      }
      const handle = dispatchProtocolAdapterExec(req, {
        writeCommand: (message) => sendProtocolAdapterMessage(message, req.remoteExecutionContext),
      })
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
