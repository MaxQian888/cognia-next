"use client"

import { useTranslations } from "next-intl"
import Link from "next/link"
import {
  ActivityIcon,
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

export function OverviewTab() {
  const t = useTranslations("settings.remoteControl.overview")
  const status = useRemoteControlStore((s) => s.status)
  const recentCalls = useRemoteControlStore((s) => s.recentCalls)
  const desktop = isTauri()

  const endpoint = status.boundPort !== null ? `http://127.0.0.1:${status.boundPort}` : ""

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
                  <span className="text-muted-foreground">{entry.at}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
