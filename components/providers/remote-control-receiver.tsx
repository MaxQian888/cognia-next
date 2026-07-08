"use client"

/**
 * Subscribes the renderer to the three Tauri events emitted by the
 * remote-control axum server in `src-tauri/src/remote_control/server.rs`:
 *
 *   `remote-control://run-task`     →  scheduler.runTaskNow(payload.taskId)
 *   `remote-control://emit-event`   →  emitSchedulerEvent(payload.eventType, …)
 *   `remote-control://inbound-call` →  push entry into the Zustand ring buffer
 *
 * No-op outside Tauri — `listen` is dynamically imported so the web bundle
 * stays free of `@tauri-apps/api/event` until the desktop runtime calls in.
 *
 * Mounted in `app/layout.tsx` next to the other top-level providers, so the
 * listeners are live for the entire app lifetime — a remote trigger can
 * arrive before the scheduler page is open.
 */

import { useEffect } from "react"
import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import { useRemoteControlStore } from "@/stores/remote-control/store"
import { emitSchedulerEvent } from "@/lib/scheduler/event-integration"
import { loggers } from "@/lib/logging"
import type {
  EmitEventRequest,
  RemoteCommand,
  RemoteControlInboundCallLog,
  RemoteControlQueryEvent,
  TriggerTaskRequest,
} from "@/types/remote-control"
import type { SchedulerEventType } from "@/lib/scheduler/event-integration"

const log = loggers.scheduler

export function RemoteControlReceiver({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!isTauri()) return

    let cancelled = false
    const unlisteners: Array<() => void> = []

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event")

      const off1 = await listen<TriggerTaskRequest>("remote-control://run-task", (event) => {
        const taskId = event.payload?.taskId
        if (!taskId) {
          log.warn("remote-control://run-task missing taskId", { payload: event.payload })
          return
        }
        log.info("remote-control: run-task", { taskId })
        void useSchedulerStore.getState().runTaskNow(taskId)
      })

      const off2 = await listen<EmitEventRequest>("remote-control://emit-event", (event) => {
        const payload = event.payload
        if (!payload?.eventType) {
          log.warn("remote-control://emit-event missing eventType", { payload })
          return
        }
        log.info("remote-control: emit-event", {
          eventType: payload.eventType,
          eventSource: payload.eventSource,
        })
        void emitSchedulerEvent(
          payload.eventType as SchedulerEventType,
          payload.data,
          payload.eventSource
        )
      })

      const off3 = await listen<RemoteControlInboundCallLog>(
        "remote-control://inbound-call",
        (event) => {
          if (!event.payload) return
          useRemoteControlStore.getState().recordInboundCall(event.payload)
        }
      )

      const [
        { dispatchRemoteCommand },
        { appendRemoteControlAudit },
        { hasNoLeakingPii },
        { answerRemoteControlQuery },
        { recordRemoteRunOutcome, markRemoteRunStatus },
      ] = await Promise.all([
        import("@/lib/remote-control/dispatch"),
        import("@/lib/db/remote-control-audit"),
        import("@/lib/twin/ingest/redact"),
        import("@/lib/remote-control/query-answerer"),
        import("@/lib/db/remote-control-run-status"),
      ])
      const off4 = await listen<RemoteCommand>("remote-control://command", (event) => {
        const command = event.payload
        if (!command?.target) {
          log.warn("remote-control://command missing target", { payload: event.payload })
          return
        }
        log.info("remote-control: command", { target: command.target, runId: command.runId })
        void dispatchRemoteCommand(command).then(async (result) => {
          // Result-loop closure: stamp the run-status projection so
          // `GET /api/v1/runs/:runId` can report the dispatch outcome. Awaited so
          // the `accepted` row exists BEFORE a fast handler's `settle` resolves
          // (otherwise the terminal mark would race ahead of the row and no-op).
          await recordRemoteRunOutcome({
            runId: result.runId,
            target: command.target,
            status: result.status,
            detail: result.detail,
          }).catch((error) => log.warn("remote-control: run-status write failed", { error }))
          // Durable audit: args are PII-gated before persistence; a leak stores
          // a redacted marker instead of the raw args.
          const safe = hasNoLeakingPii(JSON.stringify(command.args ?? {}))
          const kind =
            result.status === "accepted"
              ? "inbound.command"
              : result.status === "replayed"
                ? "inbound.replayed"
                : "inbound.rejected"
          void appendRemoteControlAudit({
            direction: "inbound",
            kind,
            target: command.target,
            runId: result.runId,
            result: result.status,
            idempotencyKey: command.idempotencyKey,
            fields: safe ? { args: command.args } : { redacted: true },
          }).catch((error) => log.warn("remote-control: audit write failed", { error }))
          // Terminal closure: long-running handlers expose a `settle` promise
          // that resolves at the run's terminal point; advance the projection
          // past `accepted` once it does.
          if (result.settle) {
            void result.settle
              .then((outcome) => markRemoteRunStatus(result.runId, outcome.status, outcome.detail))
              .catch((error) => log.warn("remote-control: settle write failed", { error }))
          }
        })
      })

      const off5 = await listen<RemoteControlQueryEvent>("remote-control://query", (event) => {
        const query = event.payload
        if (!query?.requestId || !query.kind) {
          log.warn("remote-control://query missing requestId/kind", { payload: event.payload })
          return
        }
        log.info("remote-control: query", { kind: query.kind, requestId: query.requestId })
        void answerRemoteControlQuery(query)
      })

      if (cancelled) {
        safeUnlisten(off1)
        safeUnlisten(off2)
        safeUnlisten(off3)
        safeUnlisten(off4)
        safeUnlisten(off5)
      } else {
        unlisteners.push(off1, off2, off3, off4, off5)
      }
    })().catch((error) => {
      log.error("remote-control: failed to subscribe to Tauri events", error as Error)
    })

    return () => {
      cancelled = true
      while (unlisteners.length) safeUnlisten(unlisteners.pop())
    }
  }, [])

  // Hydrate live status once on mount so the Overview tab can show the
  // current bound port without forcing the user to open the Inbound tab.
  useEffect(() => {
    if (!isTauri()) return
    void useRemoteControlStore.getState().hydrate()
  }, [])

  return <>{children}</>
}
