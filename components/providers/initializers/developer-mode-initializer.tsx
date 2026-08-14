"use client"

import { useEffect } from "react"

import { migrateDeveloperMode } from "@/lib/plugin/devtools/developer-mode"

/**
 * Boot-time one-way migration of global developer mode (ADR-0117).
 *
 * Without this, the legacy `cognia.plugins.developerMode` localStorage flag
 * would only be adopted when the user happened to open the plugin devtools
 * panel — so `managed-ide-dev-mode`, and Creator once it lands, would see
 * developer mode as off for a user who had switched it on long ago.
 *
 * Runs once per boot and writes only when the resolved value differs from the
 * persisted one. Mirrors the `ChatMiddlewareFlagInitializer` shape so the
 * `app/layout.tsx` initializer block stays homogeneous.
 */
export function DeveloperModeInitializer() {
  useEffect(() => {
    migrateDeveloperMode()
  }, [])

  return null
}

export default DeveloperModeInitializer
