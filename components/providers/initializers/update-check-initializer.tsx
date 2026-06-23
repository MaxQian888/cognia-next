"use client"

// Boot-time (and periodic) background self-update check for the desktop shell.
// Gated on `settings.updates.autoCheck` (default on). Surfaces a single Sonner
// toast with a "go install" action that opens Settings → About, where
// `UpdateCard` owns the actual download + relaunch — this initializer never
// auto-installs. No-op off the Tauri desktop shell or when the toggle is off.
// Mirrors the other boot initializers in this directory.

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { isTauri } from "@/lib/tauri"
import { checkForUpdate } from "@/lib/tauri/updater"
import { loggers } from "@/lib/logging"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useUIStore } from "@/stores/ui/ui-store"

/** Re-check every 6 hours so long-running desktop sessions still notice. */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * The Tauri updater throws this (and 404-shaped variants) when the endpoint has
 * no published release yet — the normal state before the first `v*` tag ships,
 * and on forks that never publish. That is "no update available", not a fault,
 * so we log it at debug instead of warn to keep the boot path quiet. Genuine
 * network / signature failures still surface as a warn.
 */
function isNoReleaseError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes("could not fetch a valid release json") ||
    m.includes("status code 404") ||
    m.includes("status: 404")
  )
}

export function UpdateCheckInitializer() {
  const autoCheck = useSettingsStore((s) => s.settings?.updates?.autoCheck ?? true)
  const t = useTranslations("settings.about.updates")
  // Don't re-toast the same version when the 6h interval fires again or the
  // locale flips (which re-subscribes the effect).
  const notifiedVersion = useRef<string | null>(null)

  useEffect(() => {
    if (!isTauri() || !autoCheck) return

    let cancelled = false
    const run = async () => {
      try {
        const update = await checkForUpdate()
        if (cancelled || !update) return
        if (notifiedVersion.current === update.version) return
        notifiedVersion.current = update.version
        loggers.app.info("about.autoUpdateCheck", {
          status: "available",
          version: update.version,
        })
        toast.success(t("updateAvailableBackground", { version: update.version }), {
          action: {
            label: t("goInstallAction"),
            onClick: () => useUIStore.getState().requestOpenSettings("about"),
          },
        })
      } catch (err) {
        const message = String(err)
        if (isNoReleaseError(message)) {
          loggers.app.debug("about.autoUpdateCheckNoRelease", { err: message })
        } else {
          loggers.app.warn("about.autoUpdateCheckFailed", { err: message })
        }
      }
    }

    void run()
    const id = setInterval(() => void run(), RECHECK_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [autoCheck, t])

  return null
}

export default UpdateCheckInitializer
