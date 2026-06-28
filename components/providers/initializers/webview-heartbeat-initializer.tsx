"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { startWebviewHeartbeat, takeWhiteScreenRecoveryNotice } from "@/lib/tauri/webview-watchdog"

/**
 * Renderer side of the runtime white-screen watchdog. On mount it:
 *   1. Starts the realm-lifetime heartbeat the Rust watchdog
 *      (`src-tauri/src/webview_watchdog.rs`) monitors. The heartbeat itself is a
 *      module-level singleton, so it keeps beating even after this component
 *      unmounts.
 *   2. Asks Rust whether this very load was an auto-recovery from a blank screen
 *      and, if so, toasts the user — the only point a "we recovered you" prompt
 *      can be shown, because the page that blanked was already dead.
 *
 * Mounted inside `DesktopOnlyInitializers`, so it only runs under the Tauri
 * desktop shell. Renders nothing.
 */
export function WebviewHeartbeatInitializer() {
  const t = useTranslations("whiteScreenRecovery")

  useEffect(() => {
    startWebviewHeartbeat()
    void (async () => {
      if (await takeWhiteScreenRecoveryNotice()) {
        toast.success(t("recoveredTitle"), { description: t("recoveredDescription") })
      }
    })()
  }, [t])

  return null
}

export default WebviewHeartbeatInitializer
