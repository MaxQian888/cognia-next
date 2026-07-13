"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DownloadIcon, RefreshCwIcon, RocketIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  type AvailableUpdate,
  type UpdateProgress,
} from "@/lib/tauri/updater"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { InfoRow } from "./info-row"

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
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)

  const autoCheck = useSettingsStore((s) => s.settings?.updates?.autoCheck ?? true)
  const save = useSettingsStore((s) => s.save)

  const desktop = isTauri()

  const handleCheck = async () => {
    if (!desktop) {
      toast.info(t("updates.desktopOnly"))
      return
    }
    setChecking(true)
    try {
      const update = await checkForUpdate()
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
    if (!desktop || !available || installing) return
    setInstalling(true)
    setProgress(null)
    try {
      loggers.app.info("about.updateInstall", { status: "starting", version: available.version })
      const result = await downloadAndInstallUpdate(setProgress)
      if (result === "noLongerAvailable") {
        loggers.app.info("about.updateInstall", { status: "noLongerAvailable" })
        toast.info(t("updates.updateNoLongerAvailable"))
        setAvailable(null)
        return
      }
      // "installed" relaunches the app, so the UI is torn down — leave the
      // installing state in place rather than flashing the button back.
      loggers.app.info("about.updateInstall", { status: "installed", version: available.version })
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      loggers.app.error("about.updateInstallFailed", err)
      toast.error(t("updates.updateInstallFailed", { error: errorText }))
      setInstalling(false)
      setProgress(null)
    }
  }

  // Determinate percent when the server sent a Content-Length, else null.
  const percent =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null

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
          <Button
            onClick={handleCheck}
            disabled={checking || installing || !desktop}
            data-testid="check-updates"
          >
            <RefreshCwIcon className={`mr-2 size-4 ${checking ? "animate-spin" : ""}`} />
            {checking ? t("updates.checking") : t("updates.checkUpdates")}
          </Button>
          {available && (
            <Button
              variant="default"
              onClick={handleInstall}
              disabled={installing}
              data-testid="install-update"
            >
              <DownloadIcon className={`mr-2 size-4 ${installing ? "animate-pulse" : ""}`} />
              {installing
                ? t("updates.installing")
                : t("updates.install", { version: available.version })}
            </Button>
          )}
        </div>

        {installing && (
          <div className="mt-3 space-y-1.5" data-testid="install-progress">
            <Progress value={percent ?? 0} aria-label={t("updates.installing")} />
            <p className="text-xs text-muted-foreground">
              {percent !== null
                ? t("updates.downloadingPercent", { percent })
                : t("updates.installing")}
            </p>
          </div>
        )}

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

        {desktop && (
          <div className="mt-4 flex items-center justify-between gap-4 border-t pt-4">
            <div className="space-y-0.5">
              <Label htmlFor="settings-auto-check-updates" className="text-sm">
                {t("updates.autoCheckLabel")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("updates.autoCheckDescription")}</p>
            </div>
            <Switch
              id="settings-auto-check-updates"
              checked={autoCheck}
              onCheckedChange={(checked) => void save({ updates: { autoCheck: checked } })}
              aria-label={t("updates.autoCheckLabel")}
              data-testid="auto-check-updates-toggle"
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
