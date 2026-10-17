"use client"

/**
 * BestOfNRecoveryInitializer — rebind unfinished best-of-N runs after the
 * desktop Host restarts (ADR-0230). Interrupted attempts are parked for
 * inspection, never replayed, and a publishing winner held by an integration
 * is released so the person can check and publish again.
 */

import { useEffect } from "react"

import { loggers } from "@cognia/logging"

let started = false

export function BestOfNRecoveryInitializer() {
  useEffect(() => {
    // Once per process: StrictMode remounts must not run a second recovery.
    if (started) return
    started = true
    void import("@/lib/best-of-n/restart-recovery")
      .then(({ recoverBestOfNRunsOnStartup }) => recoverBestOfNRunsOnStartup())
      .then((report) => {
        if (report.failed.length)
          loggers.agent.warn("best-of-N restart recovery left groups unrecovered", {
            failed: report.failed,
          })
      })
      .catch((error: unknown) =>
        loggers.agent.warn("best-of-N restart recovery failed", { error: String(error) })
      )
  }, [])
  return null
}

/** Test seam. */
export function __resetBestOfNRecoveryForTests() {
  started = false
}

export default BestOfNRecoveryInitializer
