"use client"

import { useEffect } from "react"
import { loggers } from "@cognia/logging"

import { ensureBootCapability, getBootProfile } from "@/lib/boot/capabilities"
import { probeConfiguredBootCapabilities } from "@/lib/boot/startup-probe"

const log = loggers.shell

export function BootProfileStartupProbe() {
  useEffect(() => {
    if (getBootProfile() !== "main") return
    void probeConfiguredBootCapabilities()
      .then((capabilities) =>
        Promise.all(capabilities.map((capability) => ensureBootCapability(capability)))
      )
      .catch((error) => {
        log.warn("main-profile background capability probe failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }, [])
  return null
}

export default BootProfileStartupProbe
