"use client"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useEffect, useState } from "react"
import { isTauri } from "@/lib/tauri"
import { getOsInfo, type OsInfo } from "@/lib/tauri/os"
import { toast } from "sonner"
import { DownloadIcon, RefreshCwIcon, RocketIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { loggers } from "@/lib/logging"

export function AboutSection() {
  const t = useTranslations("settings.about")
  const [version, setVersion] = useState<string>("")
  const [name, setName] = useState<string>("")
  const [checking, setChecking] = useState(false)
  const [available, setAvailable] = useState<{
    version: string
    body?: string
  } | null>(null)
  const [osInfo, setOsInfo] = useState<OsInfo | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void Promise.all([
      import("@tauri-apps/api/app").then((m) => m.getVersion()),
      import("@tauri-apps/api/app").then((m) => m.getName()),
      getOsInfo(),
    ])
      .then(([v, n, info]) => {
        if (!cancelled) {
          setVersion(v)
          setName(n)
          setOsInfo(info)
        }
      })
      .catch((err) => loggers.app.warn("about.metadataLoadFailed", { err: String(err) }))
    return () => {
      cancelled = true
    }
  }, [])

  const handleCheck = async () => {
    if (!isTauri()) {
      toast.info(t("desktopOnly"))
      return
    }
    setChecking(true)
    try {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      if (!update) {
        loggers.app.info("about.updateCheck", { status: "latest" })
        toast.success(t("alreadyLatest"))
        setAvailable(null)
        return
      }
      loggers.app.info("about.updateCheck", { status: "available", version: update.version })
      setAvailable({ version: update.version, body: update.body })
      toast.success(t("updateAvailableToast", { version: update.version }))
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      loggers.app.error("about.updateCheckFailed", err)
      toast.error(t("updateCheckFailed", { error: errorText }))
    } finally {
      setChecking(false)
    }
  }

  const handleInstall = async () => {
    if (!isTauri() || !available) return
    try {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      if (!update) {
        loggers.app.info("about.updateInstall", { status: "noLongerAvailable" })
        toast.info(t("updateNoLongerAvailable"))
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
      toast.error(t("updateInstallFailed", { error: errorText }))
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <RocketIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {name ? `${name} ` : ""}
          {t("versionLine")}{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">
            {version || t("versionUnknown")}
          </code>
          {!isTauri() && t("webPreview")}
        </p>
        {osInfo && (
          <p className="text-[11px] text-muted-foreground">
            {t("runningOn")}{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              {osInfo.osType} {osInfo.version}
            </code>{" "}
            ({osInfo.arch})
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <Button onClick={handleCheck} disabled={checking}>
          {checking ? (
            <>
              <RefreshCwIcon className="mr-2 size-4 animate-spin" />
              {t("checking")}
            </>
          ) : (
            <>
              <RefreshCwIcon className="mr-2 size-4" />
              {t("checkUpdates")}
            </>
          )}
        </Button>
        {available && (
          <Button variant="default" onClick={handleInstall}>
            <DownloadIcon className="mr-2 size-4" />
            {t("install", { version: available.version })}
          </Button>
        )}
      </div>

      {available && (
        <Alert>
          <AlertTitle className="text-sm">
            {t("updateAvailable", { version: available.version })}
          </AlertTitle>
          {available.body && (
            <AlertDescription className="whitespace-pre-wrap text-xs">
              {available.body}
            </AlertDescription>
          )}
        </Alert>
      )}
    </div>
  )
}
