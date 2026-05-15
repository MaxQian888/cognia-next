"use client"

/**
 * ConnectorBusProvider — Task 41.
 *
 * Boots the ConnectorBus singleton on Tauri startup:
 *   1. Reads enabled adapter rows from Dexie.
 *   2. Calls buildAdapterFromRow for each row.
 *   3. Registers each adapter with the bus.
 *   4. Installs the runtime route handler.
 *   5. Starts the outbound runner (cancelled when the provider unmounts).
 *
 * No-op in web mode (isTauri() === false).
 */

import { useEffect } from "react"
import { isTauri } from "@/lib/tauri"
import { getBus } from "@/lib/connectors/bus"
import { installRuntime } from "@/lib/connectors/runtime"
import { startOutboundRunner } from "@/lib/connectors/outbound-runner"
import { listEnabledAdapterInstances } from "@/lib/db/adapter-instances"
import { buildAdapterFromRow } from "@/lib/connectors/adapter-registry"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"

export function ConnectorBusProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!isTauri()) return

    const ac = new AbortController()
    let cancelled = false

    void (async () => {
      let enabled: Awaited<ReturnType<typeof listEnabledAdapterInstances>>
      try {
        enabled = await listEnabledAdapterInstances()
      } catch (err) {
        // Stale IndexedDB schema (e.g. v17 still cached after a v18 code bump,
        // or a blocked upgrade because another tab held the DB open). Log
        // once and bail — refusing to crash the whole app over a missing
        // connector table. A reload usually lets Dexie complete the upgrade.
        const name = err instanceof Error ? err.name : ""
        if (name === "NotFoundError") {
          console.warn(
            "[connector-bus] adapterInstances object store is missing — " +
              "IndexedDB schema is out of date. Reload the app to let Dexie " +
              "finish migrating to v18."
          )
          return
        }
        throw err
      }
      if (cancelled) return

      const bus = getBus()

      // Wire the runtime to the real `runAndCaptureAssistantReply` so the
      // ai-run branch drives a real Claude turn (subscribe → sendPrompt →
      // accumulate assistant text → resolve) instead of enqueueing a
      // placeholder. The wrapper handles its own subscription lifecycle and
      // unlistens before resolving / rejecting.
      installRuntime(bus, { runAndCapture: runAndCaptureAssistantReply })

      // Instantiate and register each enabled adapter.
      for (const row of enabled) {
        const adapter = await buildAdapterFromRow(row)
        if (cancelled) return
        if (adapter) {
          bus.registerAdapter(adapter)
          // start() is deferred to Phase 1+; the outbound runner handles delivery.
        }
      }

      if (cancelled) return

      // Build the adapter map for the outbound runner.
      const adapters = new Map(bus.listAdapters().map((a) => [a.id, a]))
      void startOutboundRunner({ adapters, signal: ac.signal })
    })()

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  return <>{children}</>
}
