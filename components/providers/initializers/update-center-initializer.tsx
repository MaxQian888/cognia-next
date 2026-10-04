"use client"

/**
 * Boot and periodic sweep for the Update Center.
 *
 * Replaces the old desktop-only check: plugins, skills, packs and extensions
 * are updatable on hosts that have no Tauri shell at all, and running two
 * schedulers would double every request to the same endpoints.
 *
 * The reminder is one Sonner toast whose action opens the Update Center. It
 * never installs anything on its own, and a critical update raises the toast
 * without blocking or closing anything, because an update that takes the app
 * away from someone mid-task is worse than the bug it fixes.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { loggers } from "@cognia/logging"
import { openUpdateCenter } from "@/lib/updates/open-update-center"
import { getUpdateCoordinator, readUpdateCenterSettings } from "@/lib/updates/runtime"
import { resolveUpdateSettings } from "@/lib/tauri/updater"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { isNativeMobile } from "@/lib/platform/detect"
import { detectOsFamily } from "@/lib/platform/os"
import { subscribeResume } from "@/lib/capacitor/app"
import { getAppUpdateInfo, subscribeFlexibleUpdateDownloaded } from "@/lib/capacitor/app-update"
import { getGooglePlayServicesStatus } from "@/lib/capacitor/google-play-services"

/**
 * Squash the boot storm. Settings hydration, locale load and StrictMode's
 * double-invoke each re-run the effect, and every re-run used to be a fresh
 * network sweep.
 */
const MIN_SWEEP_GAP_MS = 60 * 1000
let lastSweepAt = 0

/** Test-only: clear the boot-storm throttle between cases. */
export function __resetUpdateSweepThrottle(): void {
  lastSweepAt = 0
}

export function UpdateCenterInitializer() {
  const rawUpdateSettings = useSettingsStore((s) => s.settings?.updates)
  const updateSettings = resolveUpdateSettings(rawUpdateSettings)
  const t = useTranslations("updates")
  const tRef = useRef(t)
  const notified = useRef<string | null>(null)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    if (!isNativeMobile() || detectOsFamily() !== "android") return
    let cancelled = false
    let checking = false
    let checkPending = false
    let readyVersion: string | null = null
    const subscriptions: (() => void)[] = []
    const retain = (remove: () => void) => {
      if (cancelled) remove()
      else subscriptions.push(remove)
    }
    const refreshDownloaded = async () => {
      if (cancelled) return
      if (checking) {
        checkPending = true
        return
      }
      checking = true
      try {
        if (!(await getGooglePlayServicesStatus()).available || cancelled) return
        const info = await getAppUpdateInfo()
        if (cancelled || info.kind !== "ok") return
        if (!info.value.downloaded) {
          readyVersion = null
          return
        }
        // Reuse the coordinator and its consented Install action. This path
        // only discovers readiness; neither resume nor a native event installs.
        const rows = await getUpdateCoordinator().check({ kind: "mobile-android", manual: false })
        if (cancelled) return
        const ready = rows.find(
          (row) =>
            row.kind === "mobile-android" &&
            row.candidate?.source === "store" &&
            row.candidate.action === "install-in-app"
        )
        if (!ready?.candidate || readyVersion === ready.candidate.targetVersion) return
        readyVersion = ready.candidate.targetVersion
        toast.success(tRef.current("state.awaiting-restart"), {
          action: {
            label: tRef.current("toast.open"),
            onClick: () => openUpdateCenter({ focusKey: ready.key }),
          },
        })
      } catch (error) {
        loggers.app.debug("updates.resumeCheckFailed", { error: String(error) })
      } finally {
        checking = false
        if (checkPending) {
          checkPending = false
          void refreshDownloaded()
        }
      }
    }
    void (async () => {
      if (!(await getGooglePlayServicesStatus()).available || cancelled) return
      await Promise.all([
        subscribeResume(() => void refreshDownloaded()).then(retain),
        subscribeFlexibleUpdateDownloaded(() => void refreshDownloaded()).then(retain),
      ])
      await refreshDownloaded()
    })().catch((error) =>
      loggers.app.debug("updates.resumeListenerFailed", { error: String(error) })
    )
    return () => {
      cancelled = true
      for (const remove of subscriptions) remove()
    }
  }, [])

  useEffect(() => {
    if (process.env.NODE_ENV === "development") return
    const coordinator = getUpdateCoordinator()
    let cancelled = false

    const announce = (count: number, critical: boolean) => {
      const message = critical
        ? tRef.current("toast.criticalAvailable")
        : count > 1
          ? tRef.current("toast.multiple", { count })
          : tRef.current("toast.available")
      const notify = critical ? toast.warning : toast.success
      notify(message, {
        action: { label: tRef.current("toast.open"), onClick: () => openUpdateCenter() },
      })
    }

    const run = async (manual: boolean) => {
      const now = Date.now()
      if (!manual && now - lastSweepAt < MIN_SWEEP_GAP_MS) return
      lastSweepAt = now
      try {
        // A critical announcement is promised even when polling is off, so the
        // restore pass runs unconditionally and the sweep is what gets gated.
        await coordinator.restore()
        const center = readUpdateCenterSettings()
        if (!updateSettings.autoCheck && !center.notifyCritical) return
        const items = await coordinator.check({ manual: false })
        if (cancelled) return
        const actionable = items.filter(
          (item) =>
            item.candidate && (item.state === "available" || item.state === "awaiting-consent")
        )
        if (actionable.length === 0) return
        const critical = actionable.some((item) => item.candidate?.criticality === "critical")
        if (!updateSettings.autoCheck && !critical) return
        // Do not re-announce the same set on the next interval tick.
        const fingerprint = actionable
          .map((item) => `${item.key}@${item.candidate?.targetVersion}`)
          .sort()
          .join(",")
        if (notified.current === fingerprint) return
        notified.current = fingerprint
        announce(actionable.length, critical)
      } catch (error) {
        loggers.app.debug("updates.sweepFailed", { error: String(error) })
      }
    }

    void run(false)
    const id = setInterval(() => void run(false), updateSettings.checkIntervalMinutes * 60 * 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [updateSettings.autoCheck, updateSettings.checkIntervalMinutes])

  return null
}

export default UpdateCenterInitializer
