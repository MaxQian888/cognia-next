"use client"

import { useEffect } from "react"

import { stopSchedulerSystem } from "@/lib/scheduler"
import { useSchedulerStore } from "@/stores/scheduler"
import { loggers } from "@/lib/logging"

const log = loggers.scheduler

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
    if (isInitialized) return

    initialize()
      .then(() => {
        setSchedulerStatus("running")
        log.info("[SchedulerInitializer] Scheduler system initialized")
      })
      .catch((error) => {
        log.error("[SchedulerInitializer] Failed to initialize scheduler:", error)
        setSchedulerStatus("stopped")
      })

    // Cleanup on component unmount
    return () => {
      try {
        stopSchedulerSystem()
        setSchedulerStatus("stopped")
        log.info("[SchedulerInitializer] Scheduler system stopped")
      } catch (error) {
        log.error("[SchedulerInitializer] Error stopping scheduler:", error as Error)
      }
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
