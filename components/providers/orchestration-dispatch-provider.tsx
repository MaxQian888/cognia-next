"use client"

/**
 * Global bridge: Rust `orchestration_proxy` → `orchestration-proxy:exec` event →
 * `runOrchestrationExec` → `orchestration_proxy_response` (Thread D4).
 *
 * Subscribes ONCE at app layout so an external CLI agent / the Node MCP sidecar
 * can headlessly drive built-in agents, teams, and plugin tools through the
 * External Bridge orchestration tools. The round-trip is keyed by request id on
 * the Rust side. No-op in web (transport.subscribe is a no-op there).
 *
 * Without this provider, every sidecar orchestration call times out on the Rust
 * side (the proxy awaits an unresolved reply). Mount in the MAIN window only —
 * a second window would double-handle each event, but the Rust resolver is
 * idempotent (first reply wins). Mirrors `PluginToolDispatchProvider`.
 */

import { useEffect } from "react"

import {
  subscribeOrchestrationExec,
  sendOrchestrationResponse,
} from "@/lib/external-bridge/orchestration-ipc"
import { runOrchestrationExec } from "@/lib/external-bridge/handlers/orchestration"
import { loggers } from "@cognia/logging"

export function OrchestrationDispatchProvider() {
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    void subscribeOrchestrationExec((req) => {
      // runOrchestrationExec never throws (each `*Core` collapses failures onto
      // its `error` field), so the happy path is `ok: true` with the handler
      // output in `result`. The write-back is the only thing that can reject.
      void runOrchestrationExec(req.command, req.args)
        .then((result) => sendOrchestrationResponse({ id: req.id, ok: true, result }))
        .catch((err) =>
          sendOrchestrationResponse({
            id: req.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        )
        .catch((err) => {
          loggers.app.error("orchestration_proxy_response write failed", {
            id: req.id,
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

  return null
}
