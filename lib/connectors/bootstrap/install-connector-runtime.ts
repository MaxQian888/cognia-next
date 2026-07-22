/**
 * installConnectorRuntime — the shared connector bootstrap (ADR-0059 T-A5).
 *
 * This is the single implementation of the connector-subsystem boot
 * sequence, extracted verbatim from `ConnectorBusProvider`'s effect body so
 * the SAME code drives both hosts:
 *
 *   - Desktop: `components/connectors/connector-bus-provider.tsx` calls it
 *     from a `useEffect` with no options — behaviour is identical to the
 *     pre-extraction provider (including the `isTauri()` gate).
 *   - Headless brain: `lib/headless/runtimes/connector-runtime.ts` calls it
 *     with `skipHostGate` and a serve-log `log`, after remapping the Tauri
 *     command/event seams onto the companion RPC arms and `/ws/v1/events`.
 *
 * Boot sequence:
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
 *   5. Installs the runtime route handler (real Claude `runAndCapture`,
 *      behind the `safeSendPrompt` PII gate).
 *   6. Starts the outbound runner.
 *
 * The returned teardown aborts the runner signal AND calls `adapter.stop()`
 * on every adapter this install successfully started, with each failure
 * swallowed so one stuck adapter does not block the others. Scheduler-task
 * executor registration is process-lifetime (mirrors
 * `registerBuiltInExecutors()`) and is not undone by the teardown.
 */

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
import {
  startOutboundRetentionSweep,
  type DailyScheduleHandle,
} from "@/lib/connectors/daily-schedule"
import { startWorkflowExecutionBridge } from "@/lib/execution/workflow-bridge"
import { startExecutionRunPresentationRunner } from "@/lib/connectors/run-presentation/runner"
import { installExecutionRunControlHandlers } from "@/lib/execution/control-handlers"
import { recoverPendingRunInterrupts } from "@/lib/execution/run-control"
import {
  startResumeReconnect,
  type ResumeReconnectHandle,
} from "@/lib/connectors/bootstrap/resume-reconnect"
import { liveQuery } from "dexie"

export type ConnectorRuntimeLogLevel = "info" | "warn" | "error"

export interface InstallConnectorRuntimeOptions {
  /**
   * Keep only the rows this host can run. Rows filtered out are logged
   * (never silently dropped) and their adapters are neither built nor
   * registered. Default: keep every enabled row (desktop behaviour).
   */
  rowFilter?: (row: AdapterInstanceRow) => boolean
  /**
   * Operator log sink. Defaults to the console methods the provider
   * historically used (`console.info` / `console.warn` / `console.error`).
   */
  log?: (level: ConnectorRuntimeLogLevel, message: string) => void
  /**
   * Bypass the `isTauri()` host gate. The desktop provider keeps the gate
   * (no-op in web mode); the headless brain has already swapped the Tauri
   * seams for companion-RPC ones and passes `true`.
   */
  skipHostGate?: boolean
  /**
   * Acquire the cross-context "only one connector runtime" lock, returning
   * whether THIS caller owns it. The whole runtime (adapters, outbound, WS
   * reap) assumes a single `main`-role webview; a second one would double-send,
   * double-fire, and cross-reap the first's sockets. Default: a QUEUED
   * `navigator.locks` exclusive request (shared across a Tauri app's
   * same-origin webviews) that waits for the current owner and is withdrawn
   * when `signal` aborts — so a second webview boots only when the owner
   * releases (window closed / torn down), and a StrictMode remount whose
   * predecessor was just cancelled simply waits out the withdrawal instead of
   * being refused. Once granted, held until `signal` aborts. Returns `true`
   * when Web Locks is unavailable (no guard possible → don't block boot).
   * Test seam.
   */
  acquireRuntimeLock?: (signal: AbortSignal) => Promise<boolean>
  /**
   * Subscribe to changes in the enabled-adapter set so a bot configured/enabled
   * (or disabled/deleted) AFTER boot is reconciled into the running runtime
   * without an app restart. `onChange` is invoked whenever the
   * `adapterInstances` table changes; the installer diffs the enabled set and
   * hot-adds / hot-removes adapters. Returns an unsubscribe handle. Default: a
   * Dexie `liveQuery` over `listEnabledAdapterInstances`. Test seam.
   */
  subscribeAdapterChanges?: (onChange: () => void) => () => void
}

/** The Web Locks name — one exclusive holder per origin across all webviews. */
export const CONNECTOR_RUNTIME_LOCK = "cognia-connector-runtime"

/**
 * Default singleton guard via the Web Locks API. Issues a QUEUED exclusive
 * request — NOT `ifAvailable` — and, once granted, holds the lock (callback
 * promise stays pending) until `signal` aborts.
 *
 * Queued-with-`signal` semantics matter for two callers:
 *
 * - A second main-role webview waits here until the owner releases (window
 *   closed / runtime torn down) and then takes over — it never double-boots
 *   while the owner lives.
 * - A React StrictMode remount (dev): effect#1 → cleanup#1 → effect#2 run in
 *   ONE task, so effect#1's request is still queued (the webview's lock
 *   manager grants cross-process, never same-task) when effect#2's request is
 *   issued. `ifAvailable` would refuse effect#2 because effect#1 is queued
 *   ahead — leaving NO runtime at all (the dev-only "Lark connected but bot
 *   silent" bug). With `{ signal }`, cleanup#1's abort withdraws effect#1's
 *   queued request (AbortError → `false`) and effect#2 is granted next.
 *
 * Degrades to `true` when Web Locks is absent (SSR / older webview) or the
 * request fails for any reason other than our own abort — no guard, but boot
 * must not be blocked.
 */
function defaultAcquireRuntimeLock(signal: AbortSignal): Promise<boolean> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks
  if (!locks?.request) return Promise.resolve(true)
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolveAcquired) => {
    void locks
      .request(CONNECTOR_RUNTIME_LOCK, { signal }, (lock) => {
        if (!lock) {
          resolveAcquired(false)
          return
        }
        resolveAcquired(true)
        // Hold the lock for the runtime's lifetime. Aborting `signal` after
        // the grant is a no-op for the request itself (per spec), so the
        // release rides on this held promise instead.
        return new Promise<void>((release) => {
          if (signal.aborted) return release()
          signal.addEventListener("abort", () => release(), { once: true })
        })
      })
      .catch((err: unknown) => {
        // AbortError → our own teardown withdrew the still-queued request; we
        // never owned the runtime. Anything else is a lock-API failure →
        // degrade to booting, same as when Web Locks is absent.
        resolveAcquired(!(err instanceof Error && err.name === "AbortError"))
      })
  })
}

/**
 * Default enabled-adapter-set watcher. A Dexie `liveQuery` over
 * `listEnabledAdapterInstances` re-fires whenever the `adapterInstances` table
 * changes — creating a bot, toggling `enabled`, deleting a row, or a sync
 * import all write that table — so every path that adds or removes an adapter
 * reaches the reconcile without per-form wiring. The first emission fires
 * immediately with the current rows; the reconcile no-ops because those rows
 * are already booted.
 */
function defaultSubscribeAdapterChanges(onChange: () => void): () => void {
  const sub = liveQuery(() => listEnabledAdapterInstances()).subscribe({
    next: () => onChange(),
    error: () => undefined,
  })
  return () => sub.unsubscribe()
}

const consoleLog = (level: ConnectorRuntimeLogLevel, message: string): void => {
  if (level === "info") console.info(message)
  else if (level === "warn") console.warn(message)
  else console.error(message)
}

/**
 * Boot the connector subsystem. Synchronous by design — the async boot runs
 * detached (exactly like the provider effect it was extracted from) and the
 * returned teardown is safe to call at any point, including mid-boot.
 */
export function installConnectorRuntime(opts: InstallConnectorRuntimeOptions = {}): () => void {
  if (!opts.skipHostGate && !isTauri()) return () => undefined
  const log = opts.log ?? consoleLog

  const ac = new AbortController()
  let cancelled = false
  // True only after this window wins the single-runtime lock. The teardown
  // gates every shared-resource release on it — a non-owner window closing
  // must never stop the owner's inbound axum server or reap its
  // registrations.
  let ownsRuntime = false
  const startedAdapters: PlatformAdapter[] = []
  // Ids of adapters registered with the Rust axum server (webhook /
  // reverse-WS). Single source of truth for both "does the inbound server
  // need to start" and "which registrations to reap on teardown".
  const serverAdapterIds = new Set<string>()
  let cleanupHandle: CallbackBindingCleanupHandle | null = null
  let outboundRetentionSweep: DailyScheduleHandle | null = null
  let heartbeatSweep: HeartbeatSweepHandle | null = null
  let resumeReconnect: ResumeReconnectHandle | null = null
  let stopWorkflowExecutionBridge: (() => void) | null = null
  let stopExecutionRunPresentationRunner: (() => void) | null = null
  let disposeExecutionRunControlHandlers: (() => void) | null = null

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
        // installer is host-gated, so this only throws on a genuine
        // command-transport error.
        log(
          "error",
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
      log("error", `[connector-bus] adapter ${row.id} failed to start: ${message}`)
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
    // Single-runtime guard: the entire runtime assumes exactly one main-role
    // webview owns it. If another already holds the lock, do NOT boot a second
    // instance (it would double-send outbound, double-fire schedules, and
    // cross-reap the first's WS sockets). Runs before the WS reap for the same
    // reason — a second webview must not reap the owner's live sockets.
    const acquire = opts.acquireRuntimeLock ?? defaultAcquireRuntimeLock
    const owns = await acquire(ac.signal)
    if (cancelled) return
    if (!owns) {
      log(
        "warn",
        "[connector-bus] another window already owns the connector runtime; not starting a second instance"
      )
      return
    }
    ownsRuntime = true

    // Task-scheduler executors are process-lifetime registrations; they must
    // only exist in the lock-owning window, otherwise a second webview that
    // never acquired the lock would still execute due connector tasks
    // (double-send) if its scheduler fires.
    installScheduledOutboundHandlers()
    installUsagePresenceHandlers()

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
        log(
          "info",
          `[connector-bus] reaped ${reaped} leaked WS handle(s) from a prior webview load`
        )
      }
    } catch (err) {
      log(
        "warn",
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
        log(
          "warn",
          "[connector-bus] adapterInstances object store is missing — " +
            "IndexedDB schema is out of date. Reload the app to let Dexie " +
            "finish migrating to v18."
        )
        return
      }
      throw err
    }
    if (cancelled) return

    if (opts.rowFilter) {
      const skipped = enabled.filter((row) => !opts.rowFilter!(row))
      for (const row of skipped) {
        log(
          "info",
          `[connector-bus] adapter ${row.id} (${row.type}, ${row.transportMode}) skipped by host filter`
        )
      }
      enabled = enabled.filter((row) => opts.rowFilter!(row))
    }

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

    // Reclaim messages durably accepted before the previous process stopped.
    // This runs only after every enabled adapter is registered so recovered
    // jobs resolve the same capabilities and delivery paths as live traffic.
    // Stale running leases are surfaced as recovery-required and are never
    // replayed automatically by the bus.
    await bus.resumeDurableInboundJobs().catch((error) => {
      log(
        "error",
        `[connector-bus] durable inbound recovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })

    await bus.recoverActiveConversationHistory().catch((error) => {
      log(
        "error",
        `[connector-bus] active conversation history recovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })

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
          log("error", `[connector-bus] inbound server failed to start: ${message}`)
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

    // Live adapter lookup for the outbound runner — resolved through the
    // bus registry per delivery so a credential-rotation rebuild (which
    // re-registers a fresh instance) or a post-boot registration is picked
    // up immediately; a boot-time Map snapshot kept delivering through the
    // stale instance forever.
    const adapters = { get: (adapterId: string) => bus.getAdapter(adapterId) }
    // `onDelivered` feeds the bus's `cooldown-after-bot-reply` bookkeeping —
    // the delivery choke point is the only place every reply path (ai-run /
    // team / workflow / digest) converges, so recording here makes the
    // default group-chat cooldown blocker actually fire.
    void startOutboundRunner({
      adapters,
      signal: ac.signal,
      onDelivered: (conversationKey) => bus.recordBotReply(conversationKey),
    })

    // Daily retention sweep for terminal outbound rows (sent / deadlettered
    // older than 14 days) — the runner's queue soft cap only bounds the
    // ACTIVE backlog; without this sweep terminal history grows forever.
    if (!cancelled) {
      outboundRetentionSweep = startOutboundRetentionSweep()
    }

    // Single consolidated heartbeat sweep (v51) — one timer services every
    // running adapter (active heartbeat each tick + passive probe every
    // 2nd tick for passive transports) instead of up to 2N per-adapter
    // timers. Reads `listRunningAdapters()` live, so it covers adapters
    // added by a later requeue too.
    if (!cancelled) {
      heartbeatSweep = startHeartbeatSweep()
    }

    // Resume-reconnect (G3): the single owner of the OS/browser wake signals.
    // After sleep or a network drop the gateway sockets go half-open and
    // nothing else re-dials them (the gateway clients ignore heartbeat ACKs,
    // the sweep only records health). On a wake past the away threshold this
    // re-queues every running adapter through the same path as "Reconnect now".
    if (!cancelled) {
      resumeReconnect = startResumeReconnect()
    }

    // Cross-adapter housekeeping: prune expired callback bindings daily so
    // the connectorCallbackBindings table stops growing without bound.
    // `recordCallbackBinding` sets a 30 d default TTL; this sweep reaps
    // anything past `expiresAt` plus legacy pre-default rows past their
    // grace window.
    if (!cancelled) {
      cleanupHandle = startCallbackBindingCleanupSchedule()
    }

    // Source bridges write one durable execution journal; the presentation
    // runner owns native projection, coalescing, cursor commits, and fallback.
    if (!cancelled) {
      stopWorkflowExecutionBridge = startWorkflowExecutionBridge()
      stopExecutionRunPresentationRunner = startExecutionRunPresentationRunner()
      disposeExecutionRunControlHandlers = installExecutionRunControlHandlers().dispose
      void recoverPendingRunInterrupts().catch((error) => {
        console.error("[execution-run] pending interrupt recovery failed", error)
      })
    }

    // Credentials hot-reload: when Settings/Connections saves a form,
    // re-queue the matching running adapter so the keyring rotation
    // takes effect without restarting the app. The handler audits each
    // requeue with `adapter.credentials_rotated` so operators can
    // distinguish settings-driven rebuilds from manual reconnects.
    if (!cancelled) {
      const unsubscribe = subscribeCredentialsRotatedToLifecycle()
      // Wire to the same AbortController so the teardown releases the
      // listener too.
      ac.signal.addEventListener("abort", unsubscribe, { once: true })
    }

    // Hot-reconcile the enabled-adapter set: a bot created/enabled AFTER boot
    // (or disabled/deleted) is registered/torn down without an app restart.
    // The boot loop above only reads the enabled rows once, so a new adapter
    // was previously invisible to the bus (outbound → `adapter_not_found`)
    // until a reload. This diffs the enabled set against the running set on
    // every `adapterInstances` change and adds/removes the delta. The diff is
    // by id-set, so unrelated row writes (presence, capability refresh,
    // heartbeat metadata) reconcile to a no-op and never churn a live adapter.
    if (!cancelled) {
      let reconcileRunning = false
      let reconcilePending = false

      const reconcileEnabledAdapters = async (): Promise<void> => {
        if (cancelled) return
        let rows: Awaited<ReturnType<typeof listEnabledAdapterInstances>>
        try {
          rows = await listEnabledAdapterInstances()
        } catch {
          return
        }
        if (cancelled) return
        const enabledRows = opts.rowFilter ? rows.filter(opts.rowFilter) : rows
        const enabledIds = new Set(enabledRows.map((r) => r.id))
        const running = listRunningAdapters()

        // Hot-remove: a running adapter no longer in the enabled set
        // (disabled or deleted). Mirrors the teardown's per-adapter reap.
        for (const entry of running) {
          const id = entry.adapter.id
          if (enabledIds.has(id)) continue
          unregisterRunningAdapter(id) // aborts signal + stops transport
          bus.unregisterAdapter(id)
          if (serverAdapterIds.has(id)) {
            serverAdapterIds.delete(id)
            void connectorsUnregisterAdapter(id).catch(() => undefined)
          }
          void appendAudit({ adapterId: id, kind: "adapter.stopped", at: Date.now() }).catch(
            () => undefined
          )
        }

        // Hot-add: an enabled adapter not yet running (newly created/enabled).
        const runningIds = new Set(running.map((e) => e.adapter.id))
        for (const row of enabledRows) {
          if (cancelled) return
          if (runningIds.has(row.id)) continue
          try {
            const adapter = await buildAdapterFromRow(row)
            if (cancelled) return
            if (!adapter) continue
            bus.registerAdapter(adapter)
            try {
              const { getDb } = await import("@/lib/db/schema")
              await getDb().adapterInstances.update(row.id, {
                lastKnownCapabilities: adapter.a2uiCapability(),
                updatedAt: Date.now(),
              })
            } catch {
              // Best-effort capability refresh; falls back to the stale matrix.
            }
            await bootAdapter(adapter, row, bus)
          } catch (err) {
            log(
              "error",
              `[connector-bus] hot-enable of adapter ${row.id} failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          }
        }

        // A hot-added webhook / reverse-WS adapter needs the inbound server.
        // Idempotent in Rust ("already running" ⇒ success), so a no-op when it
        // is already up for another adapter.
        if (!cancelled && serverAdapterIds.size > 0) {
          try {
            await connectorsStartServer(CONNECTORS_SERVER_PORT, true)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (!/already running/i.test(message)) {
              log(
                "error",
                `[connector-bus] inbound server failed to start after hot-enable: ${message}`
              )
            }
          }
        }
      }

      // Serialize reconciles so a burst of table writes can't run two at once
      // (which would race the running-set check and double-boot an adapter).
      const runReconcile = (): void => {
        if (reconcileRunning) {
          reconcilePending = true
          return
        }
        reconcileRunning = true
        void reconcileEnabledAdapters()
          .catch(() => undefined)
          .finally(() => {
            reconcileRunning = false
            if (reconcilePending && !cancelled) {
              reconcilePending = false
              runReconcile()
            }
          })
      }

      const subscribeChanges = opts.subscribeAdapterChanges ?? defaultSubscribeAdapterChanges
      const unsubscribeChanges = subscribeChanges(runReconcile)
      ac.signal.addEventListener("abort", unsubscribeChanges, { once: true })
    }
  })().catch((err: unknown) => {
    log(
      "error",
      `[connector-bus] runtime bootstrap failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  })

  return () => {
    cancelled = true
    ac.abort()
    cleanupHandle?.dispose()
    cleanupHandle = null
    outboundRetentionSweep?.dispose()
    outboundRetentionSweep = null
    heartbeatSweep?.dispose()
    heartbeatSweep = null
    resumeReconnect?.dispose()
    resumeReconnect = null
    stopWorkflowExecutionBridge?.()
    stopWorkflowExecutionBridge = null
    stopExecutionRunPresentationRunner?.()
    stopExecutionRunPresentationRunner = null
    disposeExecutionRunControlHandlers?.()
    disposeExecutionRunControlHandlers = null
    // Tear down every running adapter through the lifecycle registry so
    // the per-adapter abort signals get cleaned up too. Swallow
    // per-adapter errors so a bad stop() can't crash the teardown; the
    // registry's `unregisterRunningAdapter` already catches the stop()
    // rejection. We still audit `adapter.stopped` on best-effort.
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
        log(
          "error",
          `[connector-bus] adapter ${adapter.id} failed to stop: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      })
    }
    // Shared Rust-side resources are owner-only: a non-owner window that
    // opened and closed must not stop the owner's inbound axum server or
    // unregister its webhook / reverse-WS routes (the owner never restarts
    // them, so webhook adapters would silently starve).
    if (!ownsRuntime) return
    // Reap this install's webhook / reverse-WS registrations so the Rust
    // registered-adapter map doesn't retain stale entries across a remount.
    // Mirrors the per-adapter registration in `bootAdapter`.
    for (const adapterId of serverAdapterIds) {
      void connectorsUnregisterAdapter(adapterId).catch(() => undefined)
    }
    serverAdapterIds.clear()
    // Stop the inbound axum server (install-lifetime). Safe no-op in Rust
    // when it was never started (no webhook / reverse-WS adapter), so we
    // swallow any error.
    void connectorsStopServer().catch(() => undefined)
  }
}
