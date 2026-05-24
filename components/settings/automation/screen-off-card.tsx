// Screen-off Computer Use (ADR-0020 follow-up) — Settings → Automation card.
//
// Surfaces the bundled virtual-display driver health, a UAC "Set up" button,
// and a "Test screen-off capture" probe (acquire → screenshot → non-black
// check → release). Mirrors `components/settings/sandbox/sandbox-section.tsx`
// (status badge + retry/probe buttons, inline errors — no toast dependency).
// Rendered only inside the Tauri shell (the OverviewTab gates on `isTauri()`);
// off-Windows it shows a "Windows-only" note instead of the action buttons.

"use client"

import { useState } from "react"

import { AlertCircle, CheckCircle2, MonitorOff, RefreshCw, ShieldOff } from "lucide-react"
import { useTranslations } from "next-intl"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useVirtualDisplayHealth } from "@/hooks/automation/use-virtual-display-health"
import { desktop, type VirtualDisplayProbeResult } from "@/lib/automation/client"

export function ScreenOffCard({ platform }: { platform?: string }) {
  const t = useTranslations("automation.screenOff")
  const { health, refresh, error } = useVirtualDisplayHealth()
  const [busy, setBusy] = useState<"setup" | "probe" | null>(null)
  const [probe, setProbe] = useState<VirtualDisplayProbeResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const isWindows = platform === undefined || platform === "windows"
  const variant: "ok" | "setup" | "down" = error ? "down" : health.available ? "ok" : "setup"

  async function onSetup() {
    setBusy("setup")
    setActionError(null)
    try {
      await desktop.virtualDisplaySetup()
      await refresh()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onProbe() {
    setBusy("probe")
    setActionError(null)
    setProbe(null)
    try {
      const result = await desktop.virtualDisplayProbe()
      setProbe(result)
      await refresh()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {variant === "ok" ? (
            <CheckCircle2 className="size-5 text-emerald-500" aria-hidden="true" />
          ) : variant === "setup" ? (
            <AlertCircle className="size-5 text-amber-500" aria-hidden="true" />
          ) : (
            <ShieldOff className="size-5 text-rose-500" aria-hidden="true" />
          )}
          <MonitorOff className="size-4" aria-hidden="true" />
          <span>{t("title")}</span>
          <Badge
            variant={variant === "ok" ? "default" : "secondary"}
            className="ml-2"
            data-testid="screen-off-status-badge"
          >
            {t(`status.${variant}`)}
          </Badge>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">{t("howItWorks")}</p>

        {!isWindows ? (
          <Alert data-testid="screen-off-windows-only">
            <MonitorOff className="size-4" aria-hidden="true" />
            <AlertDescription>{t("windowsOnlyNote")}</AlertDescription>
          </Alert>
        ) : (
          <>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">{t("driverVersion.label")}</dt>
              <dd className="font-mono">{health.driverVersion || "—"}</dd>
              {health.activeMonitor && (
                <>
                  <dt className="text-muted-foreground">{t("activeMonitor.label")}</dt>
                  <dd className="font-mono">{health.activeMonitor}</dd>
                </>
              )}
              {health.lastError && (
                <>
                  <dt className="text-muted-foreground">{t("lastError.label")}</dt>
                  <dd className="font-mono text-rose-500">{health.lastError}</dd>
                </>
              )}
              {(error || actionError) && (
                <>
                  <dt className="text-muted-foreground">{t("ipcError.label")}</dt>
                  <dd className="font-mono text-rose-500">{error ?? actionError}</dd>
                </>
              )}
            </dl>

            {probe && (
              <p
                data-testid="screen-off-probe-result"
                className={probe.nonBlack ? "text-emerald-600" : "text-rose-500"}
              >
                {probe.nonBlack
                  ? t("probeOk", {
                      width: probe.width,
                      height: probe.height,
                      monitor: probe.monitor || "—",
                    })
                  : t("probeBlack")}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-2">
              {!health.installed && (
                <Button
                  size="sm"
                  onClick={() => void onSetup()}
                  disabled={busy !== null}
                  data-testid="screen-off-setup-button"
                >
                  {busy === "setup" ? t("setupRunning") : t("setupButton")}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onProbe()}
                disabled={busy !== null || !health.available}
                data-testid="screen-off-probe-button"
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                {busy === "probe" ? t("probeRunning") : t("probeButton")}
              </Button>
              {variant !== "ok" && (
                <p className="text-xs text-muted-foreground">{t("setupNote")}</p>
              )}
            </div>

            <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
