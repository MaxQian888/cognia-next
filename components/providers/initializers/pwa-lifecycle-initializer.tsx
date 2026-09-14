"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { attachInstallListeners } from "@/lib/pwa/install-state"
import { detectPlatform } from "@/lib/platform/detect"
import { trackEvent } from "@/lib/telemetry/events/track-event"

/**
 * PWA lifecycle wiring for the web shell (web only — no-ops elsewhere):
 *
 * - attaches the `beforeinstallprompt` / `appinstalled` capture in
 *   `lib/pwa/install-state`. Mounted inside `LocaleGate` but ABOVE
 *   `AccountGate` in `app/layout.tsx`: the prompt event is single-shot and
 *   can fire while a locked vault still holds the gate closed — missing it
 *   strands the install button until reload.
 * - reports `app.pwa.installed` when the browser confirms an install.
 * - toasts when a NEW service worker takes over an already-controlled page
 *   (`skipWaiting` swap = a shipped update), so the silent version change is
 *   at least legible. The first activation (no previous controller) is not
 *   an update and does not toast.
 */
export function PwaLifecycleInitializer() {
  const t = useTranslations("settings.about.install")

  useEffect(() => {
    if (detectPlatform() !== "web") return
    const detach = attachInstallListeners()

    const onInstalled = () => void trackEvent("app.pwa.installed", {})
    window.addEventListener("appinstalled", onInstalled)

    const container = "serviceWorker" in navigator ? navigator.serviceWorker : null
    let hadController = container?.controller != null
    const onControllerChange = () => {
      if (hadController) toast.info(t("updateReady"))
      hadController = true
    }
    container?.addEventListener("controllerchange", onControllerChange)

    return () => {
      detach()
      window.removeEventListener("appinstalled", onInstalled)
      container?.removeEventListener("controllerchange", onControllerChange)
    }
  }, [t])

  return null
}

export default PwaLifecycleInitializer
