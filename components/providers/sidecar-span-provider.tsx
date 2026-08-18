"use client"

// Top-level provider that subscribes to finished spans measured INSIDE the
// sidecar and re-emits them locally (see `lib/agent-trace/sidecar-span-bridge.ts`).
//
// Without it the sidecar's spans exist only as OTLP, which requires a
// configured collector — so on a default install the trace waterfall showed the
// renderer's `invoke_agent` span with a multi-second gap where the model call
// actually ran, and nothing to fill it.
//
// Tauri-only. No-op on the plain web because `onClaudeMessage` needs the IPC
// listener that only exists inside the desktop / companion shell.

import { useEffect } from "react"

import { subscribeToSidecarSpans } from "@/lib/agent-trace/sidecar-span-bridge"
import { isTauri } from "@/lib/tauri"

export function SidecarSpanProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | null = null
    let cancelled = false

    void (async () => {
      try {
        const fn = await subscribeToSidecarSpans()
        if (cancelled) {
          fn()
        } else {
          unlisten = fn
        }
      } catch (err) {
        // Registration only fails when the IPC bus is unavailable; carry on so
        // the rest of the app still renders.
        console.warn("sidecar-span-provider: subscribe failed", err)
      }
    })()

    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

  return <>{children}</>
}
