"use client"

import { useEffect } from "react"

import { hasCapability } from "@/lib/platform/capabilities"
import { acquireExclusiveWebLock } from "@/lib/runtime/exclusive-web-lock"

/** One prober per origin, so two webviews of one app do not double the probes. */
export const HOST_LIVENESS_LOCK = "cognia-remote-host-liveness"

/**
 * Keep the paired remote hosts' liveness current (ADR-0224 A4).
 *
 * Desktop only: `always-on` is the shell that holds paired hosts it is not
 * driving and runs the ADR-0136 timing authority that reads their liveness. A
 * phone or a browser drives exactly one host, whose own connection is the
 * evidence. The probe loop is lazily imported so a desktop with no paired host
 * pays nothing beyond an empty tick.
 */
export function RemoteHostLivenessInitializer() {
  useEffect(() => {
    if (!hasCapability("always-on")) return

    const lockAbort = new AbortController()
    let stop: (() => void) | undefined
    let cancelled = false

    void (async () => {
      const won = await acquireExclusiveWebLock(HOST_LIVENESS_LOCK, lockAbort.signal)
      if (!won || cancelled) return
      const { startHostLivenessLoop } = await import("@/lib/remote-host/liveness")
      if (cancelled) return
      stop = startHostLivenessLoop()
    })().catch(() => undefined)

    return () => {
      cancelled = true
      lockAbort.abort()
      stop?.()
    }
  }, [])

  return null
}

export default RemoteHostLivenessInitializer
