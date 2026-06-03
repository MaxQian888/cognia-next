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
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import { useRemoteControlStore } from "@/stores/remote-control/store"
import { emitSchedulerEvent } from "@/lib/scheduler/event-integration"
import { loggers } from "@/lib/logging"
import type {
  EmitEventRequest,
  RemoteCommand,
  RemoteControlInboundCallLog,
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

      const { dispatchRemoteCommand } = await import("@/lib/remote-control/dispatch")
      const off4 = await listen<RemoteCommand>("remote-control://command", (event) => {
        const command = event.payload
        if (!command?.target) {
          log.warn("remote-control://command missing target", { payload: event.payload })
          return
        }
        log.info("remote-control: command", { target: command.target, runId: command.runId })
        void dispatchRemoteCommand(command).then((result) => {
          // Durable audit row is written here in a later phase (Task 5.2).
          void result
        })
      })

      if (cancelled) {
        off1()
        off2()
        off3()
        off4()
      } else {
        unlisteners.push(off1, off2, off3, off4)
      }
    })().catch((error) => {
      log.error("remote-control: failed to subscribe to Tauri events", error as Error)
    })

    return () => {
      cancelled = true
      while (unlisteners.length) unlisteners.pop()?.()
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
