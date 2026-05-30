"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DownloadIcon, RefreshCwIcon, RocketIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { loggers } from "@/lib/logging"
import { isTauri } from "@/lib/tauri"

import { InfoRow } from "./info-row"

interface AvailableUpdate {
  version: string
  body?: string
}

/**
 * Update checker (desktop only). Wraps the Tauri updater plugin: check, show
 * release notes, download + relaunch. On web / mobile it explains that
 * updates ship via the desktop build. Logic preserved from the original
 * `about-section.tsx`, plus a "last checked" line.
 */
export function UpdateCard() {
  const t = useTranslations("settings.about")
  const [checking, setChecking] = useState(false)
  const [available, setAvailable] = useState<AvailableUpdate | null>(null)
  const [lastChecked, setLastChecked] = useState<string | null>(null)

  const desktop = isTauri()

  const handleCheck = async () => {
    if (!desktop) {
      toast.info(t("updates.desktopOnly"))
      return
    }
    setChecking(true)
    try {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      setLastChecked(new Date().toLocaleString())
      if (!update) {
        loggers.app.info("about.updateCheck", { status: "latest" })
        toast.success(t("updates.alreadyLatest"))
        setAvailable(null)
        return
      }
      loggers.app.info("about.updateCheck", { status: "available", version: update.version })
      setAvailable({ version: update.version, body: update.body })
      toast.success(t("updates.updateAvailableToast", { version: update.version }))
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      loggers.app.error("about.updateCheckFailed", err)
      toast.error(t("updates.updateCheckFailed", { error: errorText }))
    } finally {
      setChecking(false)
    }
  }

  const handleInstall = async () => {
    if (!desktop || !available) return
    try {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      if (!update) {
        loggers.app.info("about.updateInstall", { status: "noLongerAvailable" })
        toast.info(t("updates.updateNoLongerAvailable"))
        return
      }
      loggers.app.info("about.updateInstall", { status: "starting", version: update.version })
      await update.downloadAndInstall()
      loggers.app.info("about.updateInstall", { status: "installed", version: update.version })
      const { relaunch } = await import("@tauri-apps/plugin-process")
      await relaunch()
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      loggers.app.error("about.updateInstallFailed", err)
      toast.error(t("updates.updateInstallFailed", { error: errorText }))
    }
  }

  return (
    <Card data-testid="about-update-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RocketIcon className="size-4" />
          {t("updates.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!desktop && (
          <p className="mb-3 text-xs text-muted-foreground" data-testid="updates-desktop-only">
            {t("updates.desktopOnly")}
          </p>
        )}
        {lastChecked && (
          <InfoRow label={t("updates.lastChecked")} value={lastChecked} testid="row-last-checked" />
        )}

        <div className="mt-2 flex flex-wrap gap-2">
          <Button onClick={handleCheck} disabled={checking || !desktop} data-testid="check-updates">
            <RefreshCwIcon className={`mr-2 size-4 ${checking ? "animate-spin" : ""}`} />
            {checking ? t("updates.checking") : t("updates.checkUpdates")}
          </Button>
          {available && (
            <Button variant="default" onClick={handleInstall} data-testid="install-update">
              <DownloadIcon className="mr-2 size-4" />
              {t("updates.install", { version: available.version })}
            </Button>
          )}
        </div>

        {available && (
          <Alert className="mt-3" data-testid="update-alert">
            <AlertTitle className="text-sm">
              {t("updates.updateAvailable", { version: available.version })}
            </AlertTitle>
            {available.body && (
              <AlertDescription className="whitespace-pre-wrap text-xs">
                {available.body}
              </AlertDescription>
            )}
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
