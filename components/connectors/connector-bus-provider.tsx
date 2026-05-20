"use client"

/**
 * ConnectorBusProvider — Task 41 + im-refactored-crayon.
 *
 * Boots the ConnectorBus singleton on Tauri startup:
 *   1. Reads enabled adapter rows from Dexie.
 *   2. Calls buildAdapterFromRow for each row.
 *   3. Registers each adapter with the bus.
 *   4. Calls `adapter.start(ctx)` so the inbound transport boots — `ctx.emit`
 *      routes events through the bus's full `dispatchInboundFull` pipeline
 *      (dedup → adapter lookup → override → policy → route handler).
 *   5. Installs the runtime route handler (real Claude `runAndCapture`).
 *   6. Starts the outbound runner.
 *
 * Cleanup on unmount: aborts the runner signal AND calls `adapter.stop()`
 * on every adapter the provider successfully started, in parallel, with
 * each failure swallowed so one stuck adapter does not block the others.
 *
 * No-op in web mode (isTauri() === false).
 */

import { useEffect } from "react"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { isTauri } from "@/lib/tauri"
import { getBus } from "@/lib/connectors/bus"
import { installRuntime } from "@/lib/connectors/runtime"
import { startOutboundRunner } from "@/lib/connectors/outbound-runner"
import { listEnabledAdapterInstances } from "@/lib/db/adapter-instances"
import { buildAdapterFromRow } from "@/lib/connectors/adapter-registry"
import { buildAdapterContext } from "@/lib/connectors/adapter-context"
import { appendAudit } from "@/lib/connectors/audit"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { defaultConnectorCallbackHandler } from "@/lib/a2ui/connector-callback-handler"
import { startAdapterHeartbeat } from "@/lib/connectors/health/heartbeat"
import {
  listRunningAdapters,
  registerRunningAdapter,
  unregisterRunningAdapter,
} from "@/lib/connectors/lifecycle"
import {
  startCallbackBindingCleanupSchedule,
  type CallbackBindingCleanupHandle,
} from "@/lib/connectors/callback-binding-cleanup"

export function ConnectorBusProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!isTauri()) return

    const ac = new AbortController()
    let cancelled = false
    const startedAdapters: PlatformAdapter[] = []
    let cleanupHandle: CallbackBindingCleanupHandle | null = null

    /**
     * Boot a single adapter through the full lifecycle: build its
     * production AdapterContext, call `adapter.start(ctx)`, register it
     * with the lifecycle registry, and start the heartbeat probe so the
     * Health Tab has a continuous signal. Returns true on success.
     * Failures are isolated — they audit `adapter.error` and swallow.
     */
    const bootAdapter = async (
      adapter: PlatformAdapter,
      row: AdapterInstanceRow,
      bus: ReturnType<typeof getBus>
    ): Promise<boolean> => {
      const perAdapterAc = new AbortController()
      const ctx = buildAdapterContext({
        adapterId: row.id,
        signal: perAdapterAc.signal,
        bus,
        publicUrl: row.publicUrl,
      })
      try {
        await adapter.start(ctx)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[connector-bus] adapter ${row.id} failed to start: ${message}`)
        await appendAudit({
          adapterId: row.id,
          kind: "adapter.error",
          at: Date.now(),
          reason: "start_failed",
          message,
        }).catch(() => undefined)
        perAdapterAc.abort()
        return false
      }
      const heartbeat = startAdapterHeartbeat({ adapter })
      registerRunningAdapter(row.id, {
        adapter,
        heartbeat,
        abortController: perAdapterAc,
        restart: async () => {
          // Same row + same adapter handle — the registry stays consistent
          // across reconnects because the adapter factory closures still
          // hold the credentials. If credentials rotated, the operator must
          // toggle the adapter off and on instead.
          await bootAdapter(adapter, row, bus)
        },
      })
      startedAdapters.push(adapter)
      await appendAudit({
        adapterId: row.id,
        kind: "adapter.started",
        at: Date.now(),
      }).catch(() => undefined)
      return true
    }

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

      // Wire the connector callback handler so inbound interactive events
      // (Slack block_actions / Lark interactive card / Telegram callback_query
      // / Discord component interactions) are projected onto the matching
      // A2UI surface and drive a fresh AI-loop turn through the digest runner.
      bus.callbackHandler = defaultConnectorCallbackHandler

      // Instantiate and register each enabled adapter.
      const { getDb } = await import("@/lib/db/schema")
      for (const row of enabled) {
        const adapter = await buildAdapterFromRow(row)
        if (cancelled) return
        if (!adapter) continue
        bus.registerAdapter(adapter)
        // G6 — refresh the per-row capability matrix from the live
        // adapter so build-options' connector-capability prompt picks
        // up post-deploy capability changes without requiring a
        // settings-tab roundtrip.
        try {
          await getDb().adapterInstances.update(row.id, {
            lastKnownCapabilities: adapter.a2uiCapability(),
            updatedAt: Date.now(),
          })
        } catch {
          // Best-effort — if the update fails the prompt section
          // simply falls back to the stale matrix already on disk.
        }

        // im-refactored-crayon — boot the adapter's inbound transport
        // through the production AdapterContext + start the heartbeat
        // loop + register with the lifecycle registry (so the Health Tab
        // can drive a manual "Reconnect now").
        await bootAdapter(adapter, row, bus)
      }

      if (cancelled) return

      // Build the adapter map for the outbound runner.
      const adapters = new Map(bus.listAdapters().map((a) => [a.id, a]))
      void startOutboundRunner({ adapters, signal: ac.signal })

      // Cross-adapter housekeeping: prune expired callback bindings daily so
      // the connectorCallbackBindings table stops growing without bound.
      // `recordCallbackBinding` sets a 30 d default TTL; this sweep reaps
      // anything past `expiresAt` plus legacy pre-default rows past their
      // grace window.
      if (!cancelled) {
        cleanupHandle = startCallbackBindingCleanupSchedule()
      }
    })()

    return () => {
      cancelled = true
      ac.abort()
      cleanupHandle?.dispose()
      cleanupHandle = null
      // Tear down every running adapter through the lifecycle registry so
      // the heartbeat handles + per-adapter abort signals get cleaned up
      // too. Swallow per-adapter errors so a bad stop() can't crash the
      // React teardown; the registry's `unregisterRunningAdapter` already
      // catches the stop() rejection. We still audit `adapter.stopped` on
      // best-effort.
      const entries = listRunningAdapters()
      for (const entry of entries) {
        const adapterId = entry.adapter.id
        unregisterRunningAdapter(adapterId)
        void appendAudit({
          adapterId,
          kind: "adapter.stopped",
          at: Date.now(),
        }).catch(() => undefined)
      }
      // Defensive fallback: if an adapter started before the registry
      // entry was recorded (e.g. an error mid-bootAdapter), still try to
      // stop the bare handle so its transport doesn't leak.
      for (const adapter of startedAdapters) {
        if (entries.some((e) => e.adapter.id === adapter.id)) continue
        void adapter.stop().catch((err) => {
          console.error(
            `[connector-bus] adapter ${adapter.id} failed to stop: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        })
      }
    }
  }, [])

  return <>{children}</>
}
