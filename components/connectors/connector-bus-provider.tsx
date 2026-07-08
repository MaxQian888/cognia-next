"use client"

/**
 * ConnectorBusProvider — Task 41 + im-refactored-crayon.
 *
 * Boots the ConnectorBus singleton on Tauri startup:
 *   0. Registers the two connector scheduler-task executors
 *      (`connection:outbound:send` / `connection:scheduled:digest`) so
 *      `TaskSchedulerImpl` can find them when a due task fires — this must
 *      happen synchronously, before step 1's async adapter boot, in case a
 *      task is already due.
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
 * Scheduler-task executor registration is process-lifetime (mirrors
 * `registerBuiltInExecutors()`) and is not undone on unmount.
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
import { installScheduledOutboundHandlers } from "@/lib/connectors/scheduled-outbound"
import { installUsagePresenceHandlers } from "@/lib/connectors/presence/usage-status-runner"
import {
  connectorsRegisterAdapter,
  connectorsResetAllWs,
  connectorsStartServer,
  connectorsStopServer,
  connectorsUnregisterAdapter,
} from "@/lib/connectors/tauri/commands"
import {
  CONNECTORS_SERVER_PORT,
  adapterNeedsInboundServer,
} from "@/lib/connectors/server-transport"
import { listEnabledAdapterInstances } from "@/lib/db/adapter-instances"
import { buildAdapterFromRow } from "@/lib/connectors/adapter-registry"
import { buildAdapterContext } from "@/lib/connectors/adapter-context"
import { appendAudit } from "@/lib/connectors/audit"
import { safeSendPrompt } from "@/lib/connectors/ai-loop/safe-send-prompt"
import { defaultConnectorCallbackHandler } from "@/lib/a2ui/connector-callback-handler"
import {
  startHeartbeatSweep,
  type HeartbeatSweepHandle,
} from "@/lib/connectors/health/heartbeat-sweep"
import { recordHeartbeatNow } from "@/lib/connectors/health/heartbeat"
import {
  listRunningAdapters,
  registerRunningAdapter,
  subscribeCredentialsRotatedToLifecycle,
  unregisterRunningAdapter,
} from "@/lib/connectors/lifecycle"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import {
  startCallbackBindingCleanupSchedule,
  type CallbackBindingCleanupHandle,
} from "@/lib/connectors/callback-binding-cleanup"
import { startWorkflowProgressRunner } from "@/lib/connectors/a2ui-bridge/workflow-progress-runner"

export function ConnectorBusProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!isTauri()) return

    installScheduledOutboundHandlers()
    installUsagePresenceHandlers()

    const ac = new AbortController()
    let cancelled = false
    const startedAdapters: PlatformAdapter[] = []
    // Ids of adapters registered with the Rust axum server (webhook /
    // reverse-WS). Single source of truth for both "does the inbound server
    // need to start" and "which registrations to reap on teardown".
    const serverAdapterIds = new Set<string>()
    let cleanupHandle: CallbackBindingCleanupHandle | null = null
    let heartbeatSweep: HeartbeatSweepHandle | null = null
    let stopWorkflowProgressRunner: (() => void) | null = null

    /**
     * Boot a single adapter through the full lifecycle: build its
     * production AdapterContext, call `adapter.start(ctx)`, register it
     * with the lifecycle registry, and fire one immediate heartbeat so the
     * Health Tab reflects this (re)boot without waiting up to one sweep
     * interval. Continuous heartbeats are driven by the bus-scope sweep
     * (v51); this immediate probe restores the pre-v51 "first heartbeat
     * fires on every boot" behaviour, which the sweep alone can't give a
     * `requeueAdapter` ("Reconnect now" / credential rotation) that lands
     * mid-interval. Returns true on success. Failures are isolated — they
     * audit `adapter.error` and swallow.
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
      // Webhook / reverse-WS adapters receive inbound events over the Rust
      // axum server. Register this adapter's type with that server BEFORE the
      // transport starts — otherwise the webhook handler 404s every inbound
      // POST because the id was never recorded (`verify_webhook` /
      // `wechat_oa_handler` resolve the branch off the registered type). The
      // Rust insert is idempotent, so a StrictMode double-mount or a
      // credential-rotation restart (this closure runs on both) is safe.
      if (adapterNeedsInboundServer(adapter, row)) {
        serverAdapterIds.add(row.id)
        try {
          await connectorsRegisterAdapter({
            adapterId: row.id,
            adapterType: adapter.meta.type,
          })
        } catch (err) {
          // Best-effort — a register failure must not block the boot. The
          // provider early-returns in web mode, so this only throws on a
          // genuine Tauri command error.
          console.error(
            `[connector-bus] adapter ${row.id} webhook registration failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
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
      // Heartbeats (active + passive-transport probe) are driven by a single
      // bus-scope sweep started after the boot loop — no per-adapter timers.
      registerRunningAdapter(row.id, {
        adapter,
        abortController: perAdapterAc,
        restart: async () => {
          // Rebuild the adapter from the persisted row so a credential
          // rotation (Settings → Save) takes effect without requiring an
          // app restart. `buildAdapterFromRow` re-reads keyring material
          // through the same getter closures, but it also re-runs any
          // startup probes (Lark `bot/v3/info`, Slack `auth.test`, etc.)
          // that captured the old credentials at build time.
          //
          // Falls back to restarting the existing handle if the row is
          // gone (race with deletion) or `buildAdapterFromRow` returns
          // null (e.g. plugin-contributed adapter is no longer loaded).
          const freshRow = await getAdapterInstance(row.id)
          if (!freshRow) {
            await bootAdapter(adapter, row, bus)
            return
          }
          const rebuilt = await buildAdapterFromRow(freshRow)
          if (!rebuilt) {
            await bootAdapter(adapter, freshRow, bus)
            return
          }
          bus.unregisterAdapter(row.id)
          bus.registerAdapter(rebuilt)
          await bootAdapter(rebuilt, freshRow, bus)
        },
      })
      startedAdapters.push(adapter)
      await appendAudit({
        adapterId: row.id,
        kind: "adapter.started",
        at: Date.now(),
      }).catch(() => undefined)
      // Immediate heartbeat so the Health view has a fresh snapshot for this
      // (re)boot now, not in up to one sweep interval. Fire-and-forget — a
      // write failure must never fail the boot.
      void recordHeartbeatNow(adapter).catch(() => undefined)
      return true
    }

    void (async () => {
      // Reap any connector WS / Lark long-connection sockets leaked by a
      // PREVIOUS webview load (hard reload / Fast-Refresh full reload / crash)
      // whose React cleanup never ran. The Rust core process survives a webview
      // reload, so those sockets — and Lark's self-reconnect loop — would
      // otherwise accumulate and deliver duplicate inbound events on every
      // reload. This MUST run before any `adapter.start()` opens a fresh socket.
      // Best-effort: a reset failure must not block the boot (first-ever load
      // reaps nothing and returns 0).
      try {
        const reaped = await connectorsResetAllWs()
        if (reaped > 0) {
          console.info(
            `[connector-bus] reaped ${reaped} leaked WS handle(s) from a prior webview load`
          )
        }
      } catch (err) {
        console.warn(
          `[connector-bus] ws reset failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      if (cancelled) return

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

      // Wire the runtime through `safeSendPrompt` — the PII gate that walks
      // the inbound prompt + injected system-prompt through `hasNoLeakingPii`
      // (fail-closed) BEFORE the model call, then delegates to the real
      // `runAndCaptureAssistantReply` (subscribe → sendPrompt → accumulate →
      // resolve). This closes the asymmetry where the primary inbound auto-
      // reply bypassed the pre-model PII gate that the digest/callback path
      // already used. `adapterId`/`conversationKey` ride in on `cap` from the
      // runtime call site so the gate attributes blocks + usage correctly.
      installRuntime(bus, {
        runAndCapture: (sessionId, prompt, options, cap) =>
          safeSendPrompt(sessionId, prompt, options, {
            ...cap,
            adapterId: cap?.adapterId ?? "",
            conversationKey: cap?.conversationKey ?? "",
          }),
      })

      // Wire the connector callback handler so inbound interactive events
      // (Slack block_actions / Lark interactive card / Telegram callback_query
      // / Discord component interactions) are projected onto the matching
      // A2UI surface and drive a fresh AI-loop turn through the digest runner.
      bus.callbackHandler = defaultConnectorCallbackHandler

      // Instantiate and register each enabled adapter.
      const { getDb } = await import("@/lib/db/schema")
      // Whether any enabled adapter receives inbound events over the Rust axum
      // server (webhook / reverse-WS) is derived from `serverAdapterIds`, which
      // `bootAdapter` populates as it registers each such adapter. The server
      // is started once, after the boot loop, only when the set is non-empty —
      // long-poll / gateway adapters dial out and need no local listener.
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
        // through the production AdapterContext + register with the
        // lifecycle registry (so the Health Tab can drive a manual
        // "Reconnect now"). Heartbeats are driven by the bus-scope sweep
        // started below, not per adapter.
        await bootAdapter(adapter, row, bus)
      }

      if (cancelled) return

      // Start the Rust axum inbound server iff a webhook / reverse-WS adapter
      // is enabled. Bind loopback-only — public reachability for webhook
      // adapters comes from the cloudflared tunnel, never a bound public
      // interface. The Rust command is idempotent (returns an "already
      // running" Err if a handle exists), which we treat as success so a
      // StrictMode double-mount can't spuriously audit a failure.
      if (!cancelled && serverAdapterIds.size > 0) {
        try {
          await connectorsStartServer(CONNECTORS_SERVER_PORT, true)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (!/already running/i.test(message)) {
            console.error(`[connector-bus] inbound server failed to start: ${message}`)
            await appendAudit({
              adapterId: "__connectors_server__",
              kind: "adapter.error",
              at: Date.now(),
              reason: "server_start_failed",
              message,
            }).catch(() => undefined)
          }
        }
      }

      // Build the adapter map for the outbound runner.
      const adapters = new Map(bus.listAdapters().map((a) => [a.id, a]))
      // `onDelivered` feeds the bus's `cooldown-after-bot-reply` bookkeeping —
      // the delivery choke point is the only place every reply path (ai-run /
      // team / workflow / digest) converges, so recording here makes the
      // default group-chat cooldown blocker actually fire.
      void startOutboundRunner({
        adapters,
        signal: ac.signal,
        onDelivered: (conversationKey) => bus.recordBotReply(conversationKey),
      })

      // Single consolidated heartbeat sweep (v51) — one timer services every
      // running adapter (active heartbeat each tick + passive probe every
      // 2nd tick for passive transports) instead of up to 2N per-adapter
      // timers. Reads `listRunningAdapters()` live, so it covers adapters
      // added by a later requeue too.
      if (!cancelled) {
        heartbeatSweep = startHeartbeatSweep()
      }

      // Cross-adapter housekeeping: prune expired callback bindings daily so
      // the connectorCallbackBindings table stops growing without bound.
      // `recordCallbackBinding` sets a 30 d default TTL; this sweep reaps
      // anything past `expiresAt` plus legacy pre-default rows past their
      // grace window.
      if (!cancelled) {
        cleanupHandle = startCallbackBindingCleanupSchedule()
      }

      // Workflow → IM fan-out runner: subscribes to `workflowRunEvents` for
      // IM-triggered runs and pushes step progress + a terminal summary
      // through the same outbound queue that everything else uses.
      if (!cancelled) {
        stopWorkflowProgressRunner = startWorkflowProgressRunner()
      }

      // Credentials hot-reload: when Settings/Connections saves a form,
      // re-queue the matching running adapter so the keyring rotation
      // takes effect without restarting the app. The handler audits each
      // requeue with `adapter.credentials_rotated` so operators can
      // distinguish settings-driven rebuilds from manual reconnects.
      if (!cancelled) {
        const unsubscribe = subscribeCredentialsRotatedToLifecycle()
        // Wire to the same AbortController so the React teardown
        // releases the listener too.
        ac.signal.addEventListener("abort", unsubscribe, { once: true })
      }
    })()

    return () => {
      cancelled = true
      ac.abort()
      cleanupHandle?.dispose()
      cleanupHandle = null
      heartbeatSweep?.dispose()
      heartbeatSweep = null
      stopWorkflowProgressRunner?.()
      stopWorkflowProgressRunner = null
      // Tear down every running adapter through the lifecycle registry so
      // the per-adapter abort signals get cleaned up too. Swallow
      // per-adapter errors so a bad stop() can't crash the
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
      // Reap this provider's webhook / reverse-WS registrations so the Rust
      // registered-adapter map doesn't retain stale entries across a remount.
      // Mirrors the per-adapter registration in `bootAdapter`.
      for (const adapterId of serverAdapterIds) {
        void connectorsUnregisterAdapter(adapterId).catch(() => undefined)
      }
      serverAdapterIds.clear()
      // Stop the inbound axum server (provider-lifetime). Safe no-op in Rust
      // when it was never started (no webhook / reverse-WS adapter), so we
      // call it unconditionally and swallow any error.
      void connectorsStopServer().catch(() => undefined)
    }
  }, [])

  return <>{children}</>
}
