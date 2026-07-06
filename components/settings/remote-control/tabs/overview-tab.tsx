"use client"

import { useTranslations } from "next-intl"
import Link from "next/link"
import {
  ActivityIcon,
  BarChart3Icon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  PowerIcon,
  PowerOffIcon,
  SendIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { isTauri } from "@/lib/tauri"
import { emitSchedulerEvent } from "@/lib/scheduler/event-integration"
import { useRemoteControlStore } from "@/stores/remote-control/store"

/** Localized time for a recent-call ISO stamp; falls back to the raw value. */
function formatCallTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString()
}

export function OverviewTab() {
  const t = useTranslations("settings.remoteControl.overview")
  const status = useRemoteControlStore((s) => s.status)
  const recentCalls = useRemoteControlStore((s) => s.recentCalls)
  const desktop = isTauri()

  const endpoint = status.boundPort !== null ? `http://127.0.0.1:${status.boundPort}` : ""

  // Derive a small traffic snapshot from the recent-calls ring buffer (last 20).
  const windowSize = recentCalls.length
  const successCount = recentCalls.filter((c) => c.status >= 200 && c.status < 300).length
  const errorCount = windowSize - successCount
  const successRate = windowSize > 0 ? Math.round((successCount / windowSize) * 100) : null

  const onEmitTest = async () => {
    try {
      await emitSchedulerEvent("custom", { source: "remote-control-test" })
      toast.success(t("testEventDispatched"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            {status.inboundRunning ? (
              <PowerIcon className="h-4 w-4 text-emerald-500" />
            ) : (
              <PowerOffIcon className="h-4 w-4 text-muted-foreground" />
            )}
            {status.inboundRunning ? t("statusActive", { endpoint }) : t("statusInactive")}
          </CardTitle>
          {!desktop && (
            <CardDescription className="text-xs">{t("statusDesktopOnly")}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {endpoint && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{t("endpointUrlLabel")}</span>
              <code className="rounded bg-muted px-2 py-0.5 text-xs">{endpoint}</code>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{t("totalCallsLabel")}</span>
            <span className="font-mono text-xs">{status.inboundCallsTotal}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{t("lastCallAt")}</span>
            <span className="font-mono text-xs">{status.lastCallAt ?? t("lastCallNever")}</span>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={onEmitTest}>
              <SendIcon className="mr-2 h-3.5 w-3.5" />
              {t("sendTestEvent")}
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link href="/scheduler">
                {t("openSchedulerLink")}
                <ExternalLinkIcon className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <BarChart3Icon className="h-4 w-4" />
            {t("metricsHeading")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {windowSize === 0 ? (
            <p className="text-xs text-muted-foreground">{t("metricNoData")}</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border bg-muted/30 p-3 text-center">
                  <div className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {successCount}
                  </div>
                  <div className="text-xs text-muted-foreground">{t("metricSuccess")}</div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3 text-center">
                  <div
                    className={`text-lg font-semibold tabular-nums ${
                      errorCount > 0 ? "text-destructive" : ""
                    }`}
                  >
                    {errorCount}
                  </div>
                  <div className="text-xs text-muted-foreground">{t("metricErrors")}</div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3 text-center">
                  <div className="text-lg font-semibold tabular-nums">{successRate}%</div>
                  <div className="text-xs text-muted-foreground">{t("metricSuccessRate")}</div>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("metricWindowNote", { count: windowSize })}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ActivityIcon className="h-4 w-4" />
            {t("recentCallsHeading")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentCalls.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noRecentCalls")}</p>
          ) : (
            <ul className="space-y-2">
              {recentCalls.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-xs"
                >
                  <CheckCircle2Icon
                    className={
                      entry.status >= 200 && entry.status < 300
                        ? "h-3.5 w-3.5 text-emerald-500"
                        : "h-3.5 w-3.5 text-destructive"
                    }
                  />
                  <span className="font-mono">{entry.status}</span>
                  <code className="flex-1 truncate text-muted-foreground">{entry.route}</code>
                  <span className="text-muted-foreground">{entry.remoteIp}</span>
                  <span className="text-muted-foreground" title={entry.at}>
                    {formatCallTime(entry.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
