"use client"

// Top-level provider that subscribes to sidecar `usage_headers` events and
// persists each one into the `subscriptionUsage` Dexie table. Mount once in
// the app layout — without it, passive usage collection (Phase 4a) doesn't run.
//
// Tauri-only. No-op on the web because `onClaudeMessage` requires the IPC
// listener which only exists inside the desktop shell.

import { useEffect } from "react"

import { subscribeToUsageHeaders } from "@/lib/subscription/anthropic/usage-collector"
import { isTauri } from "@/lib/tauri"

export function SubscriptionUsageProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | null = null
    let cancelled = false

    void (async () => {
      try {
        const fn = await subscribeToUsageHeaders()
        if (cancelled) {
          fn()
        } else {
          unlisten = fn
        }
      } catch (err) {
        // Listener registration only fails when the IPC bus is unavailable;
        // log + carry on so the rest of the app still renders.
        console.warn("subscription-usage-provider: subscribe failed", err)
      }
    })()

    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

  return <>{children}</>
}
