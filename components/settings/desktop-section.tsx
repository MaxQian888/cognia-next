"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { CopyIcon, ExternalLinkIcon, LaptopIcon, PowerIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { isTauri } from "@/lib/tauri"
import { isAutostartEnabled, setAutostart } from "@/lib/tauri/autostart"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { openExternal, revealInExplorer } from "@/lib/tauri/opener"
import { getOsInfo, type OsInfo } from "@/lib/tauri/os"
import { getCloseBehavior, setCloseBehavior, type CloseBehavior } from "@/lib/tauri/close-behavior"
import { invoke } from "@tauri-apps/api/core"
import { loggers } from "@cognia/logging"
import { TraySection } from "./tray-section"

/**
 * Desktop-only preferences. Combined surface for autostart, system info, and
 * a few tray/file-system actions that exist purely in the desktop runtime.
 *
 * Renders a no-op message in web mode so the tab is still discoverable
 * during `pnpm dev` without throwing.
 */
export function DesktopSection() {
  const t = useTranslations("settings.desktop")
  const [osInfo, setOsInfo] = useState<OsInfo | null>(null)
  const [autostart, setAutostartState] = useState<boolean>(false)
  const [closeBehavior, setCloseBehaviorState] = useState<CloseBehavior>("ask")
  const [loaded, setLoaded] = useState(false)
  const [appDataDir, setAppDataDir] = useState<string | null>(null)

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!isTauri()) {
      setLoaded(true)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const [info, auto, behavior, dir] = await Promise.all([
          getOsInfo(),
          isAutostartEnabled(),
          getCloseBehavior(),
          import("@tauri-apps/api/path").then((m) => m.appDataDir()),
        ])
        if (cancelled) return
        setOsInfo(info)
        setAutostartState(auto)
        setCloseBehaviorState(behavior)
        setAppDataDir(dir)
      } catch (err) {
        loggers.app.warn("desktop.loadFailed", { err: String(err) })
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  if (!isTauri()) {
    return (
      <div className="space-y-2">
        <Label className="flex items-center gap-2">
          <LaptopIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t("webOnlyHintBefore")}
          <code className="rounded bg-muted px-1 py-0.5">{t("webOnlyHintCode")}</code>
          {t("webOnlyHintAfter")}
        </p>
      </div>
    )
  }

  const handleAutostart = async (checked: boolean) => {
    try {
      await setAutostart(checked)
      setAutostartState(checked)
      loggers.app.info("desktop.autostart", { enabled: checked })
      toast.success(checked ? t("launchOnToast") : t("launchOffToast"))
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      loggers.app.error("desktop.autostartFailed", err)
      toast.error(t("launchAutostartFailed", { error: errorText }))
    }
  }

  const handleCloseBehavior = async (value: CloseBehavior) => {
    setCloseBehaviorState(value)
    try {
      await setCloseBehavior(value)
      loggers.app.info("desktop.closeBehavior", { behavior: value })
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      loggers.app.error("desktop.closeBehaviorFailed", err)
      toast.error(t("closeBehaviorFailed", { error: errorText }))
    }
  }

  const handleRevealData = async () => {
    if (!appDataDir) return
    try {
      await revealInExplorer(appDataDir)
      loggers.app.info("desktop.revealDataDir", { path: appDataDir })
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      loggers.app.error("desktop.revealFailed", err)
      toast.error(t("revealFailed", { error: errorText }))
    }
  }

  const handleCopyDebug = async () => {
    const lines = [
      `App: Cognia ${typeof window !== "undefined" ? "" : ""}`,
      osInfo
        ? `OS: ${osInfo.osType} ${osInfo.version} (${osInfo.arch}, ${osInfo.family})`
        : "OS: (unknown)",
      osInfo?.locale ? `Locale: ${osInfo.locale}` : null,
      osInfo?.hostname ? `Hostname: ${osInfo.hostname}` : null,
      appDataDir ? `Data dir: ${appDataDir}` : null,
      `User agent: ${typeof navigator !== "undefined" ? navigator.userAgent : "n/a"}`,
    ].filter(Boolean)
    const text = lines.join("\n")
    try {
      await writeClipboardText(text)
      loggers.app.info("desktop.copyDebug", { length: text.length })
      toast.success(t("copyDebugSuccess"))
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      loggers.app.error("desktop.copyDebugFailed", err)
      toast.error(t("copyDebugFailed", { error: errorText }))
    }
  }

  const handleOpenDocs = async () => {
    await openExternal("https://v2.tauri.app/plugin/")
  }

  const handleTestNotification = async () => {
    const { ensureNotificationPermission, notify } = await import("@/lib/tauri/notification")
    const granted = await ensureNotificationPermission()
    if (granted !== "granted") {
      loggers.app.warn("desktop.notificationDenied")
      toast.warning(t("notificationDenied"))
      return
    }
    await notify({
      title: t("notificationTitle"),
      body: t("notificationBody"),
    })
    loggers.app.info("desktop.testNotification")
  }

  const handlePing = async () => {
    try {
      const out = await invoke<string>("greet", { name: "desktop" })
      loggers.app.info("desktop.pingRust", { ok: true })
      toast.message(t("pingTitle"), { description: out })
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      loggers.app.error("desktop.pingFailed", err)
      toast.error(t("pingFailed", { error: errorText }))
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <LaptopIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
      </div>

      <section className="space-y-3 rounded-md border p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-sm flex items-center gap-2">
              <PowerIcon className="size-3.5" />
              {t("launchAtLogin")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("launchAtLoginHint")}</p>
            <p className="text-xs text-muted-foreground">{t("schedulerBackgroundHint")}</p>
          </div>
          <Switch
            checked={autostart}
            onCheckedChange={(c) => void handleAutostart(c)}
            disabled={!loaded}
            aria-label={t("launchAtLoginToggle")}
          />
        </div>

        <div className="space-y-2 border-t pt-3">
          <div className="space-y-1">
            <Label className="text-sm">{t("closeBehavior")}</Label>
            <p className="text-xs text-muted-foreground">{t("closeBehaviorHint")}</p>
          </div>
          <RadioGroup
            value={closeBehavior}
            onValueChange={(v) => void handleCloseBehavior(v as CloseBehavior)}
            disabled={!loaded}
            aria-label={t("closeBehavior")}
          >
            <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
              <RadioGroupItem value="ask" />
              {t("closeBehaviorAsk")}
            </Label>
            <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
              <RadioGroupItem value="tray" />
              {t("closeBehaviorTray")}
            </Label>
            <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
              <RadioGroupItem value="quit" />
              {t("closeBehaviorQuit")}
            </Label>
          </RadioGroup>
        </div>
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <Label className="text-sm">{t("system")}</Label>
        {!loaded ? (
          <Skeleton className="h-16 w-full" />
        ) : osInfo ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t("platform")}</dt>
            <dd className="font-mono">
              {osInfo.osType} ({osInfo.platform})
            </dd>
            <dt className="text-muted-foreground">{t("architecture")}</dt>
            <dd className="font-mono">{osInfo.arch}</dd>
            <dt className="text-muted-foreground">{t("version")}</dt>
            <dd className="font-mono">{osInfo.version}</dd>
            <dt className="text-muted-foreground">{t("family")}</dt>
            <dd className="font-mono">{osInfo.family}</dd>
            {osInfo.locale && (
              <>
                <dt className="text-muted-foreground">{t("locale")}</dt>
                <dd className="font-mono">{osInfo.locale}</dd>
              </>
            )}
            {appDataDir && (
              <>
                <dt className="text-muted-foreground">{t("dataDir")}</dt>
                <dd className="break-all font-mono text-[11px]">{appDataDir}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">{t("osUnavailable")}</p>
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleRevealData()}
            disabled={!appDataDir}
          >
            <ExternalLinkIcon className="mr-2 size-3.5" />
            {t("revealDataDir")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleCopyDebug()}>
            <CopyIcon className="mr-2 size-3.5" />
            {t("copyDebug")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleTestNotification()}>
            {t("testNotification")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handlePing()}>
            {t("pingRust")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleOpenDocs()}>
            {t("tauriDocs")}
          </Button>
        </div>
      </section>

      <section className="space-y-3 rounded-md border p-4">
        <TraySection />
      </section>
    </div>
  )
}
