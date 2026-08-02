"use client"

import { useState, useSyncExternalStore, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DownloadIcon, RefreshCwIcon, RocketIcon, RotateCcwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  downloadUpdate,
  getInstalledVersionAwaitingRestart,
  installUpdate,
  isUpdateErrorPhase,
  relaunchAfterUpdate,
  resolveUpdateSettings,
  subscribeInstalledVersionAwaitingRestart,
  type AvailableUpdate,
  type UpdateProgress,
} from "@/lib/tauri/updater"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { AboutCard } from "./about-card"
import { InfoRow } from "./info-row"

const CHECK_INTERVALS = [15, 60, 360, 720, 1440, 10080] as const
const REQUEST_TIMEOUTS = [15, 30, 60, 120, 300] as const

function PreferenceRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string
  description: string
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col justify-between gap-2 py-2 sm:flex-row sm:items-center sm:gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={htmlFor} className="text-sm">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function UpdateCard() {
  const t = useTranslations("settings.about")
  const rawUpdateSettings = useSettingsStore((s) => s.settings?.updates)
  const lastUpdateCheckAt = useSettingsStore((s) => s.settings?.lastUpdateCheckAt)
  const save = useSettingsStore((s) => s.save)
  const saveUpdateSettings = useSettingsStore((s) => s.saveUpdateSettings)
  const updateSettings = resolveUpdateSettings(rawUpdateSettings)

  const [checking, setChecking] = useState(false)
  const [available, setAvailable] = useState<AvailableUpdate | null>(null)
  const [lastChecked, setLastChecked] = useState<string | null>(() =>
    lastUpdateCheckAt ? new Date(lastUpdateCheckAt).toLocaleString() : null
  )
  const [downloading, setDownloading] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [installing, setInstalling] = useState(false)
  const restartRequired = useSyncExternalStore(
    subscribeInstalledVersionAwaitingRestart,
    () => getInstalledVersionAwaitingRestart() !== null,
    () => false
  )
  const [progress, setProgress] = useState<UpdateProgress | null>(null)

  const desktop = isTauri()

  const persistUpdateSettings = async (patch: Partial<typeof updateSettings>) => {
    try {
      await saveUpdateSettings(patch)
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      loggers.app.error("about.updateSettingsSaveFailed", error)
      toast.error(t("updates.settingsSaveFailed", { error: errorText }))
    }
  }

  const recordSuccessfulCheck = async () => {
    const checkedAt = Date.now()
    setLastChecked(new Date(checkedAt).toLocaleString())
    try {
      await save({ lastUpdateCheckAt: checkedAt })
    } catch (error) {
      loggers.app.warn("about.updateCheckTimestampPersistFailed", { error: String(error) })
    }
  }

  const runDownload = async () => {
    setDownloading(true)
    setProgress(null)
    try {
      const result = await downloadUpdate(setProgress)
      if (result === "noLongerAvailable") {
        setAvailable(null)
        setDownloaded(false)
        toast.info(t("updates.updateNoLongerAvailable"))
        return false
      }
      if (result === "web") return false
      setDownloaded(true)
      toast.success(t("updates.updateDownloadedToast"))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      loggers.app.error("about.updateDownloadFailed", error)
      toast.error(t("updates.updateDownloadFailed", { error: message }))
      return false
    } finally {
      setDownloading(false)
      setProgress(null)
    }
  }

  const handleCheck = async () => {
    if (restartRequired) return
    setChecking(true)
    setDownloaded(false)
    try {
      const update = await checkForUpdate()
      await recordSuccessfulCheck()
      if (!update) {
        loggers.app.info("about.updateCheck", { status: "latest" })
        toast.success(t("updates.alreadyLatest"))
        setAvailable(null)
        return
      }
      loggers.app.info("about.updateCheck", { status: "available", version: update.version })
      setAvailable(update)
      toast.success(t("updates.updateAvailableToast", { version: update.version }))
      if (updateSettings.autoDownload) await runDownload()
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      loggers.app.error("about.updateCheckFailed", error)
      toast.error(t("updates.updateCheckFailed", { error: errorText }))
    } finally {
      setChecking(false)
    }
  }

  const handleInstall = async () => {
    if (!desktop || !available || installing || downloading) return
    setInstalling(true)
    setProgress(null)
    try {
      loggers.app.info("about.updateInstall", { status: "starting", version: available.version })
      const options = { relaunch: updateSettings.relaunchAfterInstall }
      const result = downloaded
        ? await installUpdate(options)
        : await downloadAndInstallUpdate(setProgress, options)
      if (result === "noLongerAvailable") {
        loggers.app.info("about.updateInstall", { status: "noLongerAvailable" })
        toast.info(t("updates.updateNoLongerAvailable"))
        setAvailable(null)
        return
      }
      if (result === "installed") {
        setInstalling(false)
        toast.success(t("updates.installedRestartRequired"))
        return
      }
      loggers.app.info("about.updateInstall", { status: result, version: available.version })
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      if (isUpdateErrorPhase(error, "relaunch")) {
        loggers.app.error("about.updateRelaunchFailed", error)
        toast.error(t("updates.updateRelaunchFailed", { error: errorText }))
        setInstalling(false)
        setProgress(null)
        return
      }
      loggers.app.error("about.updateInstallFailed", error)
      toast.error(t("updates.updateInstallFailed", { error: errorText }))
      setInstalling(false)
      setProgress(null)
    }
  }

  const handleRestart = async () => {
    try {
      await relaunchAfterUpdate()
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      loggers.app.error("about.updateRelaunchFailed", error)
      toast.error(t("updates.updateRelaunchFailed", { error: errorText }))
    }
  }

  const percent =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null
  const busy = checking || downloading || installing

  return (
    <AboutCard icon={RocketIcon} title={t("updates.title")} testid="about-update-card">
      {!desktop && (
        <p
          className="mb-3 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs text-pretty text-muted-foreground"
          data-testid="updates-desktop-only"
        >
          {t("updates.desktopOnly")}
        </p>
      )}
      {lastChecked && (
        <InfoRow label={t("updates.lastChecked")} value={lastChecked} testid="row-last-checked" />
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          onClick={handleCheck}
          disabled={busy || !desktop || restartRequired}
          data-testid="check-updates"
        >
          <RefreshCwIcon className={`mr-2 size-4 ${checking ? "animate-spin" : ""}`} />
          {checking ? t("updates.checking") : t("updates.checkUpdates")}
        </Button>
        {available && !downloaded && (
          <Button
            variant="outline"
            onClick={() => void runDownload()}
            disabled={busy}
            data-testid="download-update"
          >
            <DownloadIcon className={`mr-2 size-4 ${downloading ? "animate-pulse" : ""}`} />
            {downloading ? t("updates.downloading") : t("updates.download")}
          </Button>
        )}
        {available && (
          <Button onClick={handleInstall} disabled={busy} data-testid="install-update">
            <DownloadIcon className={`mr-2 size-4 ${installing ? "animate-pulse" : ""}`} />
            {installing
              ? t("updates.installing")
              : t("updates.install", { version: available.version })}
          </Button>
        )}
        {restartRequired && (
          <Button onClick={handleRestart} data-testid="restart-update">
            <RotateCcwIcon className="mr-2 size-4" />
            {t("updates.restartNow")}
          </Button>
        )}
      </div>

      {(downloading || installing) && (
        <div className="mt-3 space-y-1.5" data-testid="install-progress">
          <Progress
            value={percent ?? 0}
            aria-label={downloading ? t("updates.downloading") : t("updates.installing")}
          />
          <p className="text-xs text-muted-foreground">
            {percent !== null
              ? t("updates.downloadingPercent", { percent })
              : downloading
                ? t("updates.downloading")
                : t("updates.installing")}
          </p>
        </div>
      )}

      {downloaded && (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="update-downloaded">
          {t("updates.downloadedReady")}
        </p>
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
        <>
          <Separator className="my-4" />
          <div className="divide-y">
            <PreferenceRow
              htmlFor="settings-auto-check-updates"
              label={t("updates.autoCheckLabel")}
              description={t("updates.autoCheckDescription")}
            >
              <Switch
                id="settings-auto-check-updates"
                checked={updateSettings.autoCheck}
                onCheckedChange={(autoCheck) => void persistUpdateSettings({ autoCheck })}
                aria-label={t("updates.autoCheckLabel")}
                data-testid="auto-check-updates-toggle"
              />
            </PreferenceRow>
            <PreferenceRow
              htmlFor="settings-update-check-interval"
              label={t("updates.checkIntervalLabel")}
              description={t("updates.checkIntervalDescription")}
            >
              <Select
                value={String(updateSettings.checkIntervalMinutes)}
                onValueChange={(value) =>
                  void persistUpdateSettings({ checkIntervalMinutes: Number(value) })
                }
                disabled={!updateSettings.autoCheck}
              >
                <SelectTrigger
                  id="settings-update-check-interval"
                  className="w-40"
                  aria-label={t("updates.checkIntervalLabel")}
                  data-testid="update-check-interval"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {CHECK_INTERVALS.map((minutes) => (
                      <SelectItem key={minutes} value={String(minutes)}>
                        {t(`updates.intervals.${minutes}`)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </PreferenceRow>
            <PreferenceRow
              htmlFor="settings-auto-download-updates"
              label={t("updates.autoDownloadLabel")}
              description={t("updates.autoDownloadDescription")}
            >
              <Switch
                id="settings-auto-download-updates"
                checked={updateSettings.autoDownload}
                onCheckedChange={(autoDownload) => void persistUpdateSettings({ autoDownload })}
                aria-label={t("updates.autoDownloadLabel")}
                data-testid="auto-download-updates-toggle"
              />
            </PreferenceRow>
            <PreferenceRow
              htmlFor="settings-relaunch-after-update"
              label={t("updates.relaunchAfterInstallLabel")}
              description={t("updates.relaunchAfterInstallDescription")}
            >
              <Switch
                id="settings-relaunch-after-update"
                checked={updateSettings.relaunchAfterInstall}
                onCheckedChange={(relaunchAfterInstall) =>
                  void persistUpdateSettings({ relaunchAfterInstall })
                }
                aria-label={t("updates.relaunchAfterInstallLabel")}
                data-testid="relaunch-after-update-toggle"
              />
            </PreferenceRow>
            <PreferenceRow
              htmlFor="settings-update-timeout"
              label={t("updates.requestTimeoutLabel")}
              description={t("updates.requestTimeoutDescription")}
            >
              <Select
                value={String(updateSettings.requestTimeoutSeconds)}
                onValueChange={(value) =>
                  void persistUpdateSettings({ requestTimeoutSeconds: Number(value) })
                }
              >
                <SelectTrigger
                  id="settings-update-timeout"
                  className="w-40"
                  aria-label={t("updates.requestTimeoutLabel")}
                  data-testid="update-request-timeout"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {REQUEST_TIMEOUTS.map((seconds) => (
                      <SelectItem key={seconds} value={String(seconds)}>
                        {t("updates.timeoutSeconds", { seconds })}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </PreferenceRow>
            <PreferenceRow
              htmlFor="settings-update-use-proxy"
              label={t("updates.useProxyLabel")}
              description={t("updates.useProxyDescription")}
            >
              <Switch
                id="settings-update-use-proxy"
                checked={updateSettings.useProxy}
                onCheckedChange={(useProxy) => void persistUpdateSettings({ useProxy })}
                aria-label={t("updates.useProxyLabel")}
                data-testid="update-use-proxy-toggle"
              />
            </PreferenceRow>
          </div>
        </>
      )}
    </AboutCard>
  )
}
