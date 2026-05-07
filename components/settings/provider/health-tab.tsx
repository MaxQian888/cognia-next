"use client"

import { useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { Activity, Check, Clock, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SettingsCard, SettingsDivider } from "@/components/settings/common/settings-section"
import { cn } from "@/lib/utils"

interface HealthCheckEntry {
  timestamp: number
  success: boolean
  latency?: number
  error?: string
  outcome?: "verified" | "failed" | "limited"
}

interface HealthTabProps {
  providerId: string
  onTestConnection: () => Promise<{
    success: boolean
    latency?: number
    error?: string
    outcome?: "verified" | "failed" | "limited"
  }>
  isTesting?: boolean
}

const MAX_HISTORY = 20

function getHealthStatus(
  history: HealthCheckEntry[]
): "healthy" | "degraded" | "error" | "unknown" {
  if (history.length === 0) return "unknown"
  const last = history[0]
  if (last.success) return "healthy"
  const recentFailures = history.filter((h) => !h.success).length
  if (recentFailures >= 3) return "error"
  return "degraded"
}

function LatencyBars({ history }: { history: HealthCheckEntry[] }) {
  const t = useTranslations("providers.healthView")
  const slice = history.slice(0, 10).reverse()
  if (slice.length === 0) return null

  const maxLatency = Math.max(...slice.map((h) => h.latency ?? 0), 1)

  return (
    <div className="flex items-end gap-1.5 h-24">
      {slice.map((entry, i) => {
        const height = Math.max(4, ((entry.latency ?? 0) / maxLatency) * 100)
        const color = !entry.success
          ? "bg-destructive/60"
          : (entry.latency ?? 0) < 200
            ? "bg-green-500/60"
            : (entry.latency ?? 0) < 500
              ? "bg-amber-500/60"
              : "bg-destructive/60"

        return (
          <div
            key={i}
            className="flex flex-1 flex-col items-center gap-1"
            title={`${entry.latency ?? "—"}${t("ms")}`}
          >
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {entry.latency ?? "—"}
            </span>
            <div
              className={cn("w-full rounded-t-sm transition-all", color)}
              style={{ height: `${height}%` }}
            />
          </div>
        )
      })}
    </div>
  )
}

export function HealthTab({
  providerId: _providerId,
  onTestConnection,
  isTesting = false,
}: HealthTabProps) {
  const t = useTranslations("providers.healthView")
  const [history, setHistory] = useState<HealthCheckEntry[]>([])

  const status = getHealthStatus(history)
  const lastCheck = history.length > 0 ? history[0].timestamp : null

  const handleRunCheck = useCallback(async () => {
    const result = await onTestConnection()
    setHistory((prev) =>
      [
        {
          timestamp: Date.now(),
          success: result.success,
          latency: result.latency,
          error: result.error,
          outcome: result.outcome,
        },
        ...prev,
      ].slice(0, MAX_HISTORY)
    )
  }, [onTestConnection])

  const statusConfig: Record<
    string,
    {
      label: string
      variant: "default" | "secondary" | "destructive" | "outline"
      className: string
    }
  > = {
    healthy: {
      label: t("healthy"),
      variant: "default",
      className:
        "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400",
    },
    degraded: {
      label: t("degraded"),
      variant: "outline",
      className:
        "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400",
    },
    error: {
      label: t("error"),
      variant: "destructive",
      className: "",
    },
    unknown: {
      label: t("unknown"),
      variant: "secondary",
      className: "",
    },
  }

  return (
    <div className="space-y-5">
      {/* Health status card */}
      <SettingsCard
        icon={<Activity className="h-4 w-4" />}
        title={t("statusTitle")}
        headerAction={
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={handleRunCheck}
            disabled={isTesting}
          >
            {isTesting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("runCheck")}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("statusLabel")}</span>
            <Badge
              variant={statusConfig[status].variant}
              className={cn("text-[11px]", statusConfig[status].className)}
            >
              {statusConfig[status].label}
            </Badge>
          </div>
          {lastCheck && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>
                {t("lastCheck")}: {new Date(lastCheck).toLocaleTimeString()}
              </span>
            </div>
          )}
          {history.length > 0 && history[0].latency !== undefined && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {history[0].latency}
                {t("ms")}
              </span>
            </div>
          )}
        </div>
      </SettingsCard>

      {/* Latency chart */}
      {history.length > 0 && (
        <>
          <SettingsDivider />
          <SettingsCard icon={<Activity className="h-4 w-4" />} title={t("latencyChart")}>
            <LatencyBars history={history} />
          </SettingsCard>
        </>
      )}

      {/* Status timeline */}
      <SettingsDivider />
      <SettingsCard icon={<Clock className="h-4 w-4" />} title={t("timeline")}>
        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Activity className="mb-2 h-8 w-8 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">{t("noData")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {history.slice(0, 5).map((entry, i) => (
              <div
                key={i}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2",
                  entry.success
                    ? "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/20"
                    : "border-destructive/20 bg-destructive/5"
                )}
              >
                {entry.success ? (
                  <Check className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <X className="h-4 w-4 shrink-0 text-destructive" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">
                    {entry.success ? t("healthy") : t("error")}
                    {entry.outcome === "limited" && ` (${t("degraded")})`}
                  </p>
                  {entry.error && (
                    <p className="truncate text-[11px] text-muted-foreground">{entry.error}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  {entry.latency !== undefined && (
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {entry.latency}
                      {t("ms")}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
    </div>
  )
}

export default HealthTab
