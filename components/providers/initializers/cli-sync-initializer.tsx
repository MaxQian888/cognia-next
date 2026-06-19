"use client"

// Fires once on app boot (Tauri desktop only). When the user enabled
// `cliBridge.autoSync`, pushes the desktop's agent config + provider
// credentials + recent input history into the cognia CLI home so the
// standalone `cognia-agent` CLI runs with the same setup without a second
// login. A desktop coming online IS the "online" trigger for the
// push-when-online policy. No-op when auto-sync is off or off-desktop.

import { useEffect, useRef } from "react"

import { getSettings } from "@/lib/db/settings"
import { maybeAutoPushToCli } from "@/lib/cli-bridge/auto-push"
import { isTauri } from "@/lib/tauri"

export function CliSyncInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    if (!isTauri()) return
    void (async () => {
      try {
        const settings = await getSettings()
        await maybeAutoPushToCli(settings)
      } catch {
        // Best-effort: a boot-time CLI push must never block app startup.
      }
    })()
  }, [])

  return null
}

export default CliSyncInitializer
