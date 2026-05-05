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

export function ConnectorBusProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!isTauri()) return

    const ac = new AbortController()
    let cancelled = false

    void (async () => {
      const enabled = await listEnabledAdapterInstances()
      if (cancelled) return

      const bus = getBus()

      // Phase 1: stub sendPrompt. The real chat pipeline is driven by the
      // composer's standard onSend path (auto mode) or enqueueOutbound (manual
      // mode). This runtime wires routing / draft / store-only decisions.
      // TODO(phase 1+): wire to lib/claude/ipc.ts:sendPrompt for streaming.
      installRuntime(bus, {
        sendPrompt: async () => {
          // Placeholder — see runtime.ts for the ai-run stub comment.
        },
      })

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
