"use client"

// Boot-time (and periodic) background self-update check for the desktop shell.
// Gated on `settings.updates.autoCheck` (default on). Surfaces a single Sonner
// toast whose "Install" action downloads + relaunches in place (reusing the
// handle the check just cached) — one click, no detour through Settings. The
// check never auto-installs; the install is always user-initiated. No-op off
// the Tauri desktop shell or when the toggle is off. Mirrors the other boot
// initializers in this directory.

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { isTauri } from "@/lib/tauri"
import { checkForUpdate, downloadAndInstallUpdate } from "@/lib/tauri/updater"
import { loggers } from "@cognia/logging"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** Re-check every 6 hours so long-running desktop sessions still notice. */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Minimum gap between two automatic checks. Boot used to fire the effect
 * several times back-to-back — settings-store hydration re-evaluating
 * `autoCheck`, locale/message loading re-creating `t` (formerly an effect
 * dep), and StrictMode's dev double-invoke — and each re-subscription ran an
 * immediate network check, so a single boot could hit the update endpoint six
 * times. Module-level so the throttle survives effect re-mounts within the
 * same window; the 6-hour interval comfortably clears it.
 */
const MIN_AUTO_CHECK_GAP_MS = 60 * 1000
let lastAutoCheckAt = 0

/** Test-only: clear the boot-storm throttle between cases. */
export function __resetAutoCheckThrottle(): void {
  lastAutoCheckAt = 0
}

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
  // Don't re-toast the same version when the 6h interval fires again.
  const notifiedVersion = useRef<string | null>(null)
  // Keep the latest translator out of the main effect's deps: a locale flip
  // re-creates `t`, and re-subscribing the effect used to fire an immediate
  // extra network check on every boot-time context change.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    if (!isTauri() || !autoCheck) return

    let cancelled = false

    // One-click install from the toast action: download + relaunch in place.
    // The handle was cached by the preceding `checkForUpdate`, so this does not
    // re-hit the network on the happy path.
    const install = async () => {
      const toastId = toast.loading(tRef.current("installing"))
      try {
        const result = await downloadAndInstallUpdate()
        if (result === "noLongerAvailable") {
          toast.info(tRef.current("updateNoLongerAvailable"), { id: toastId })
        }
        // "installed" relaunches the app; "web" can't happen on the desktop path.
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        loggers.app.error("about.autoUpdateInstallFailed", err)
        toast.error(tRef.current("updateInstallFailed", { error }), { id: toastId })
      }
    }

    const run = async () => {
      // Squash the boot storm: effect re-subscriptions (autoCheck hydration,
      // StrictMode double-invoke) within the gap share the first check.
      const now = Date.now()
      if (now - lastAutoCheckAt < MIN_AUTO_CHECK_GAP_MS) return
      lastAutoCheckAt = now
      try {
        const update = await checkForUpdate()
        if (cancelled || !update) return
        if (notifiedVersion.current === update.version) return
        notifiedVersion.current = update.version
        loggers.app.info("about.autoUpdateCheck", {
          status: "available",
          version: update.version,
        })
        toast.success(tRef.current("updateAvailableBackground", { version: update.version }), {
          action: {
            label: tRef.current("goInstallAction"),
            onClick: () => void install(),
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
  }, [autoCheck])

  return null
}

export default UpdateCheckInitializer
