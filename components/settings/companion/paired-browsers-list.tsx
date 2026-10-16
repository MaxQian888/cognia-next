"use client"

import { useCallback, useEffect, useState } from "react"
import { BotIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { localTransport as transport } from "@/lib/tauri"

/** Mirrors Rust `ws_browser_companion::PairedBrowser`. */
export interface PairedBrowser {
  deviceId: string
  displayName: string
  status: string
  createdAt: number
  connected: boolean
  extensionVersion: string | null
  driveAllowed: boolean
}

export interface PairedBrowsersListProps {
  /** Test seam — defaults to `companion_browser_extension_list`. */
  loadBrowsers?: () => Promise<PairedBrowser[]>
  /** Test seam — defaults to `companion_browser_extension_set_drive`. */
  setDrive?: (deviceId: string, allowed: boolean) => Promise<void>
  /** How often the connection state is re-read, in milliseconds. */
  refreshMs?: number
}

const defaultLoadBrowsers = () =>
  transport.call<PairedBrowser[]>("companion_browser_extension_list", {})

const defaultSetDrive = (deviceId: string, allowed: boolean) =>
  transport.call<void>("companion_browser_extension_set_drive", { deviceId, allowed })

/**
 * The browsers paired with this Host, and whether agents may act in each
 * (ADR-0228 §5).
 *
 * `browser.drive` is never granted by pairing; this switch is where the Owner
 * grants it, one browser at a time. Turning it on asks first, because what it
 * allows — an agent clicking and typing in the user's signed-in tabs — is a
 * different thing from the capture the browser was paired for. Turning it off
 * takes effect on the next operation and needs no confirmation.
 */
export function PairedBrowsersList({
  loadBrowsers = defaultLoadBrowsers,
  setDrive = defaultSetDrive,
  refreshMs = 5_000,
}: PairedBrowsersListProps) {
  const t = useTranslations("mobile.companion.browserCompanion")
  const [browsers, setBrowsers] = useState<PairedBrowser[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<PairedBrowser | null>(null)

  const refresh = useCallback(async () => {
    try {
      setBrowsers(await loadBrowsers())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [loadBrowsers])

  useEffect(() => {
    let cancelled = false
    const tick = () => {
      void loadBrowsers()
        .then((next) => {
          if (cancelled) return
          setBrowsers(next)
          setFailed(false)
        })
        .catch(() => {
          if (!cancelled) setFailed(true)
        })
    }
    tick()
    // The connection state changes on its own — a browser opens or closes —
    // so it is re-read while the card is open rather than only on mount.
    const timer = window.setInterval(tick, refreshMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [loadBrowsers, refreshMs])

  const apply = useCallback(
    async (browser: PairedBrowser, allowed: boolean) => {
      setConfirming(null)
      setPending(browser.deviceId)
      try {
        await setDrive(browser.deviceId, allowed)
      } catch {
        setFailed(true)
      } finally {
        setPending(null)
        await refresh()
      }
    },
    [refresh, setDrive]
  )

  return (
    <div className="space-y-2" data-testid="paired-browsers">
      {failed ? (
        <p className="text-xs text-destructive" data-testid="paired-browsers-error">
          {t("pairedLoadFailed")}
        </p>
      ) : null}
      {browsers && browsers.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="paired-browsers-empty">
          {t("pairedEmpty")}
        </p>
      ) : null}
      {browsers && browsers.length > 0 ? (
        <ul className="space-y-2">
          {browsers.map((browser) => (
            <li
              key={browser.deviceId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-control border px-2.5 py-2"
              data-testid={`paired-browser-${browser.deviceId}`}
            >
              <div className="min-w-0 space-y-0.5">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <span className="truncate">{browser.displayName}</span>
                  <Badge variant={browser.connected ? "secondary" : "outline"}>
                    {browser.connected ? t("pairedConnected") : t("pairedOffline")}
                  </Badge>
                </p>
                {browser.extensionVersion ? (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {t("pairedVersion", { version: browser.extensionVersion })}
                  </p>
                ) : null}
              </div>
              <label className="flex items-center gap-2 text-xs">
                <BotIcon className="size-3.5" aria-hidden="true" />
                <span>{t("driveLabel")}</span>
                <Switch
                  checked={browser.driveAllowed}
                  disabled={pending === browser.deviceId || browser.status !== "active"}
                  aria-label={t("driveAria", { name: browser.displayName })}
                  onCheckedChange={(next) => {
                    if (next) setConfirming(browser)
                    else void apply(browser, false)
                  }}
                  data-testid={`paired-browser-drive-${browser.deviceId}`}
                />
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("pairedHint")}</p>
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      >
        <AlertDialogContent data-testid="paired-browser-drive-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("driveConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("driveConfirmDescription", { name: confirming?.displayName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("driveConfirmCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming) void apply(confirming, true)
              }}
              data-testid="paired-browser-drive-confirm"
            >
              {t("driveConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
