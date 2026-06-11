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
        loggers.app.warn("about.autoUpdateCheckFailed", { err: String(err) })
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
