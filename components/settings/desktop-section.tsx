"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { CopyIcon, ExternalLinkIcon, LaptopIcon, PowerIcon } from "lucide-react"
import { isTauri } from "@/lib/tauri"
import { isAutostartEnabled, setAutostart } from "@/lib/tauri/autostart"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { openExternal, revealInExplorer } from "@/lib/tauri/opener"
import { getOsInfo, type OsInfo } from "@/lib/tauri/os"
import { getPref, setPref } from "@/lib/tauri/store"
import { invoke } from "@tauri-apps/api/core"

const PREF_TRAY_ON_CLOSE = "tray.minimize-on-close"

/**
 * Desktop-only preferences. Combined surface for autostart, system info, and
 * a few tray/file-system actions that exist purely in the desktop runtime.
 *
 * Renders a no-op message in web mode so the tab is still discoverable
 * during `pnpm dev` without throwing.
 */
export function DesktopSection() {
  const [osInfo, setOsInfo] = useState<OsInfo | null>(null)
  const [autostart, setAutostartState] = useState<boolean>(false)
  const [trayOnClose, setTrayOnClose] = useState<boolean>(false)
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
        const [info, auto, tray, dir] = await Promise.all([
          getOsInfo(),
          isAutostartEnabled(),
          getPref<boolean>(PREF_TRAY_ON_CLOSE),
          import("@tauri-apps/api/path").then((m) => m.appDataDir()),
        ])
        if (cancelled) return
        setOsInfo(info)
        setAutostartState(auto)
        setTrayOnClose(Boolean(tray))
        setAppDataDir(dir)
        // Re-push the saved preference into Rust in case TauriProvider hadn't
        // reached the store yet — keeps the close handler in sync.
        try {
          await invoke("set_tray_on_close", { enabled: Boolean(tray) })
        } catch {
          // Non-fatal — Rust may not have the command on web/dev mode.
        }
      } catch (err) {
        console.warn("DesktopSection load failed", err)
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
          Desktop preferences
        </Label>
        <p className="text-xs text-muted-foreground">
          Available in the desktop build only. Run{" "}
          <code className="rounded bg-muted px-1 py-0.5">pnpm tauri dev</code> to see this tab in
          action.
        </p>
      </div>
    )
  }

  const handleAutostart = async (checked: boolean) => {
    try {
      await setAutostart(checked)
      setAutostartState(checked)
      toast.success(checked ? "Cognia will launch at login." : "Launch-at-login disabled.")
    } catch (err) {
      toast.error(`Could not change autostart: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleTrayOnClose = async (checked: boolean) => {
    setTrayOnClose(checked)
    await setPref(PREF_TRAY_ON_CLOSE, checked)
    try {
      await invoke("set_tray_on_close", { enabled: checked })
    } catch (err) {
      toast.error(
        `Could not update close behavior: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  const handleRevealData = async () => {
    if (!appDataDir) return
    try {
      await revealInExplorer(appDataDir)
    } catch (err) {
      toast.error(
        `Could not open data directory: ${err instanceof Error ? err.message : String(err)}`
      )
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
      toast.success("Debug info copied to clipboard.")
    } catch (err) {
      toast.error(`Copy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleOpenDocs = async () => {
    await openExternal("https://v2.tauri.app/plugin/")
  }

  const handleTestNotification = async () => {
    const { ensureNotificationPermission, notify } = await import("@/lib/tauri/notification")
    const granted = await ensureNotificationPermission()
    if (granted !== "granted") {
      toast.warning("Notification permission not granted.")
      return
    }
    await notify({
      title: "Cognia",
      body: "Test notification — your desktop integration is wired up.",
    })
  }

  // Use the version we already had wired in About — shell out via the
  // app api just like AboutSection does, to avoid coupling.
  const handlePing = async () => {
    try {
      const out = await invoke<string>("greet", { name: "desktop" })
      toast.message("Greet roundtrip", { description: out })
    } catch (err) {
      toast.error(`greet failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <LaptopIcon className="size-4" />
          Desktop preferences
        </Label>
        <p className="text-xs text-muted-foreground">
          Settings that only apply when running as the native desktop app.
        </p>
      </div>

      <section className="space-y-3 rounded-md border p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-sm flex items-center gap-2">
              <PowerIcon className="size-3.5" />
              Launch at login
            </Label>
            <p className="text-xs text-muted-foreground">
              Start Cognia automatically when you sign in to your computer.
            </p>
          </div>
          <Switch
            checked={autostart}
            onCheckedChange={(c) => void handleAutostart(c)}
            disabled={!loaded}
            aria-label="Toggle launch at login"
          />
        </div>

        <div className="flex items-start justify-between gap-4 border-t pt-3">
          <div className="space-y-1">
            <Label className="text-sm">Minimize to tray on close</Label>
            <p className="text-xs text-muted-foreground">
              Closing the window hides Cognia to the system tray instead of quitting. Quit
              explicitly from the tray menu.
            </p>
          </div>
          <Switch
            checked={trayOnClose}
            onCheckedChange={(c) => void handleTrayOnClose(c)}
            disabled={!loaded}
            aria-label="Toggle minimize to tray"
          />
        </div>
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <Label className="text-sm">System</Label>
        {!loaded ? (
          <Skeleton className="h-16 w-full" />
        ) : osInfo ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Platform</dt>
            <dd className="font-mono">
              {osInfo.osType} ({osInfo.platform})
            </dd>
            <dt className="text-muted-foreground">Architecture</dt>
            <dd className="font-mono">{osInfo.arch}</dd>
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-mono">{osInfo.version}</dd>
            <dt className="text-muted-foreground">Family</dt>
            <dd className="font-mono">{osInfo.family}</dd>
            {osInfo.locale && (
              <>
                <dt className="text-muted-foreground">Locale</dt>
                <dd className="font-mono">{osInfo.locale}</dd>
              </>
            )}
            {appDataDir && (
              <>
                <dt className="text-muted-foreground">Data dir</dt>
                <dd className="break-all font-mono text-[11px]">{appDataDir}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">OS info unavailable.</p>
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleRevealData()}
            disabled={!appDataDir}
          >
            <ExternalLinkIcon className="mr-2 size-3.5" />
            Reveal data directory
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleCopyDebug()}>
            <CopyIcon className="mr-2 size-3.5" />
            Copy debug info
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleTestNotification()}>
            Test notification
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handlePing()}>
            Ping Rust
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleOpenDocs()}>
            Tauri docs
          </Button>
        </div>
      </section>
    </div>
  )
}
