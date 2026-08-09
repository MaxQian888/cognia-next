"use client"

import { useEffect } from "react"

import { stopSchedulerSystem } from "@/lib/scheduler"
import { useSchedulerStore } from "@/stores/scheduler"
import { installExecutionEventBridge } from "@/lib/execution/event-bridge"
import { loggers } from "@cognia/logging"
import { reconcileAgentTaskRuntime } from "@/lib/agent-tasks/runtime"

const log = loggers.scheduler
let schedulerInitializerMounts = 0
let pendingStopVersion = 0

/**
 * SchedulerInitializer Component
 *
 * Initializes the task scheduler system on app startup and handles graceful shutdown.
 * Delegates to the store's initialize() to avoid duplicate initialization paths.
 * Should be placed in the app providers to ensure scheduler runs throughout the app lifecycle.
 */
export function SchedulerInitializer() {
  const initialize = useSchedulerStore((state) => state.initialize)
  const isInitialized = useSchedulerStore((state) => state.isInitialized)
  const setSchedulerStatus = useSchedulerStore((state) => state.setSchedulerStatus)

  useEffect(() => {
    schedulerInitializerMounts += 1
    pendingStopVersion += 1
    let active = true

    // Bridge the ExecutionBroker's leg-completed events into the scheduler event
    // system so an event-triggered task can react to "any chat / agent run
    // finished" (fills the chat:completed + agent:completed gaps; goal/team/plan
    // already emit their own subsystem-level events). Idempotent.
    const teardownBridge = installExecutionEventBridge()

    if (!isInitialized) {
      initialize()
        .then(async () => {
          await reconcileAgentTaskRuntime()
          if (!active) return
          setSchedulerStatus("running")
          log.info("[SchedulerInitializer] Scheduler system initialized")
        })
        .catch((error) => {
          if (!active) return
          log.error("[SchedulerInitializer] Failed to initialize scheduler:", error)
          setSchedulerStatus("stopped")
        })
    } else {
      void reconcileAgentTaskRuntime().catch((error) => {
        log.error("[SchedulerInitializer] Failed to reconcile Agent tasks:", error)
      })
    }

    // Cleanup on component unmount
    return () => {
      active = false
      teardownBridge()
      schedulerInitializerMounts = Math.max(0, schedulerInitializerMounts - 1)
      const stopVersion = ++pendingStopVersion

      // React StrictMode replays effects as mount → cleanup → mount. Defer the
      // destructive stop to a microtask so the immediate remount can retain
      // the single live scheduler instead of creating a ghost listener.
      queueMicrotask(() => {
        if (schedulerInitializerMounts > 0 || stopVersion !== pendingStopVersion) return
        try {
          stopSchedulerSystem()
          setSchedulerStatus("stopped")
          log.info("[SchedulerInitializer] Scheduler system stopped")
        } catch (error) {
          log.error("[SchedulerInitializer] Error stopping scheduler:", error as Error)
        }
      })
    }
  }, [initialize, isInitialized, setSchedulerStatus])

  // Handle beforeunload for graceful shutdown
  useEffect(() => {
    const handleBeforeUnload = () => {
      try {
        stopSchedulerSystem()
      } catch (error) {
        log.error("[SchedulerInitializer] Error on beforeunload:", error as Error)
      }
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [])

  return null
}
