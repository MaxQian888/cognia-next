"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, DownloadIcon, Loader2Icon, ShareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useInstallPrompt } from "@/hooks/use-install-prompt"
import { detectPlatform } from "@/lib/platform/detect"
import { trackEvent } from "@/lib/telemetry/events/track-event"

import { AboutCard } from "./about-card"

/**
 * "Install Cognia" entry for the browser shell. Renders only on `web` —
 * Tauri and Capacitor are already installed apps. The four states come from
 * `lib/pwa/install-state`: `installable` (deferred prompt captured → native
 * dialog button), `installed` (already a standalone window), `ios-manual`
 * (iOS Safari: Share → Add to Home Screen), `unavailable`.
 */
export function InstallAppCard() {
  const t = useTranslations("settings.about")
  const { status, install } = useInstallPrompt()
  const [installing, setInstalling] = useState(false)
  const shownTracked = useRef(false)

  const isWeb = detectPlatform() === "web"

  useEffect(() => {
    if (!isWeb || shownTracked.current || status !== "installable") return
    shownTracked.current = true
    void trackEvent("app.pwa.install.shown", {})
  }, [isWeb, status])

  if (!isWeb) return null

  const handleInstall = async () => {
    setInstalling(true)
    try {
      const outcome = await install()
      void trackEvent(
        outcome === "accepted" ? "app.pwa.install.accepted" : "app.pwa.install.dismissed",
        {}
      )
    } finally {
      setInstalling(false)
    }
  }

  return (
    <AboutCard icon={DownloadIcon} title={t("install.title")} testid="install-app-card">
      <p className="text-xs text-pretty text-muted-foreground">{t("install.description")}</p>

      {status === "installable" && (
        <Button
          type="button"
          size="sm"
          className="mt-3"
          disabled={installing}
          onClick={() => void handleInstall()}
          data-testid="install-app-action"
        >
          {installing ? (
            <Loader2Icon aria-hidden className="size-4 animate-spin" />
          ) : (
            <DownloadIcon aria-hidden className="size-4" />
          )}
          {t("install.action")}
        </Button>
      )}

      {status === "installed" && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-foreground">
          <CheckCircle2Icon aria-hidden className="size-4 text-emerald-500" />
          {t("install.installed")}
        </p>
      )}

      {status === "ios-manual" && (
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-foreground">
          <li className="flex items-center gap-1.5">
            <ShareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {t("install.iosStepShare")}
          </li>
          <li>{t("install.iosStepAdd")}</li>
        </ol>
      )}

      {status === "unavailable" && (
        <p className="mt-3 text-xs text-muted-foreground">{t("install.unavailable")}</p>
      )}
    </AboutCard>
  )
}

export default InstallAppCard
