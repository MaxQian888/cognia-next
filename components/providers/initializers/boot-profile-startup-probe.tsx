"use client"

import { useEffect } from "react"
import { loggers } from "@cognia/logging"

import { ensureBootCapability, getBootProfile } from "@/lib/boot/capabilities"
import { probeConfiguredBootCapabilities } from "@/lib/boot/startup-probe"
import { useAccountStore } from "@/stores/account/account-store"

const log = loggers.shell

export function BootProfileStartupProbe() {
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  useEffect(() => {
    if (getBootProfile() !== "main" || !unlockedAccountId) return
    let cancelled = false
    void probeConfiguredBootCapabilities()
      .then((capabilities) => {
        if (cancelled) return
        return Promise.all(capabilities.map((capability) => ensureBootCapability(capability)))
      })
      .catch((error) => {
        if (cancelled) return
        log.warn("main-profile background capability probe failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return () => {
      cancelled = true
    }
  }, [unlockedAccountId])
  return null
}

export default BootProfileStartupProbe
