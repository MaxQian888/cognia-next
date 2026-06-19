"use client"

/**
 * Per-adapter Health detail tab (im-refactored-crayon).
 *
 * Renders the live state pill, a 24h × 30min dot grid (derived from
 * the connectorAudit table), the most-recent OK + Error rows, the
 * pending outbound queue count carried by the latest heartbeat, and a
 * "Reconnect now" affordance that drives `requeueAdapter` against the
 * lifecycle registry.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleIcon,
  LoaderIcon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { useAdapterHealth } from "@/hooks/connectors/use-adapter-health"
import { requeueAdapter } from "@/lib/connectors/lifecycle"
import type { HealthCellState } from "@/lib/connectors/health/derive-history"

const STATE_TINT: Record<HealthCellState, string> = {
  running: "bg-emerald-500",
  starting: "bg-sky-400",
  degraded: "bg-amber-500",
  down: "bg-destructive",
  unknown: "bg-muted-foreground/30",
}

const STATE_TEXT: Record<HealthCellState, string> = {
  running: "text-emerald-700 dark:text-emerald-300",
  starting: "text-sky-700 dark:text-sky-300",
  degraded: "text-amber-700 dark:text-amber-300",
  down: "text-destructive",
  unknown: "text-muted-foreground",
}

const BREAKER_TEXT: Record<"closed" | "open" | "half_open", string> = {
  closed: "text-emerald-700 dark:text-emerald-300",
  half_open: "text-amber-700 dark:text-amber-300",
  open: "text-destructive",
}

const BREAKER_BG: Record<"closed" | "open" | "half_open", string> = {
  closed: "bg-emerald-500",
  half_open: "bg-amber-500",
  open: "bg-destructive",
}

export interface HealthDetailProps {
  adapterId: string
}

export function HealthDetail({ adapterId }: HealthDetailProps) {
  const t = useTranslations("settings.connections.adapters.health")
  const desktop = isTauri()
  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectMessage, setReconnectMessage] = useState<string | null>(null)
  // Ticking "now" for the rate-bucket countdown so we don't read Date.now()
  // during render (react-hooks/purity). 1s cadence matches a refill timer's
  // resolution without flooding renders.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const {
    current,
    buckets,
    lastOk,
    lastError,
    pendingOutboundCount,
    breaker,
    rateBucket,
    atGateBlocks,
  } = useAdapterHealth(adapterId)

  const onReconnect = async () => {
    if (!desktop) return
    setReconnecting(true)
    setReconnectMessage(null)
    try {
      const ok = await requeueAdapter(adapterId)
      setReconnectMessage(ok ? t("reconnectQueued") : t("noData"))
    } catch (err) {
      setReconnectMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setReconnecting(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card data-testid="health-detail-summary">
        <CardHeader className="pb-2 pt-3">
          <CardTitle className="flex items-center justify-between text-sm font-medium">
            <span className="flex items-center gap-2">
              <ActivityIcon className="h-4 w-4" />
              {t("title")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onReconnect()}
              disabled={!desktop || reconnecting}
              data-testid="health-reconnect-now"
            >
              {reconnecting ? (
                <LoaderIcon className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t("reconnectNow")}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <CircleIcon
              className={cn("h-3 w-3 fill-current shrink-0", STATE_TEXT[current.state])}
              data-testid="health-state-dot"
            />
            <Badge
              variant="outline"
              className={cn("font-medium", STATE_TEXT[current.state])}
              data-testid="health-state-pill"
            >
              {t(`state.${current.state}`)}
            </Badge>
            {current.reason && (
              <span className="text-xs text-muted-foreground truncate">{current.reason}</span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
            <div className="flex items-center gap-1.5">
              <CheckCircle2Icon className="h-3.5 w-3.5 text-emerald-500" />
              <span className="text-muted-foreground">{t("lastOk")}:</span>
              <span className="font-mono">
                {lastOk ? new Date(lastOk.at).toLocaleTimeString() : t("noData")}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <XCircleIcon className="h-3.5 w-3.5 text-destructive" />
              <span className="text-muted-foreground">{t("lastError")}:</span>
              <span className="font-mono">
                {lastError ? new Date(lastError.at).toLocaleTimeString() : t("noData")}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{t("pendingOutbound")}:</span>
              <Badge variant={pendingOutboundCount > 0 ? "default" : "outline"} className="text-xs">
                {pendingOutboundCount}
              </Badge>
            </div>
            {lastError?.message && (
              <div className="col-span-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 font-mono text-xs text-destructive">
                {lastError.message}
              </div>
            )}
          </div>

          {reconnectMessage && (
            <div className="text-xs text-muted-foreground" data-testid="health-reconnect-message">
              {reconnectMessage}
            </div>
          )}
        </CardContent>
      </Card>

      {atGateBlocks.total > 0 && (
        <Card data-testid="health-detail-atgate">
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="text-sm font-medium">{t("atGateTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <p className="text-muted-foreground">
              {t("atGateTotal", { count: atGateBlocks.total })}
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {atGateBlocks.byReason.map(({ reason, count }) => (
                <li key={reason}>
                  <Badge variant="outline" className="text-xs">
                    {t(`atGateReason.${reason}`)} · {count}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {(breaker || rateBucket) && (
        <Card data-testid="health-detail-runtime">
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="text-sm font-medium">{t("runtimeTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {breaker && (
              <div
                className="flex flex-wrap items-center gap-2 text-xs"
                data-testid="health-breaker"
              >
                <span className="text-muted-foreground">{t("breakerLabel")}:</span>
                <Badge
                  variant="outline"
                  className={cn("font-medium", BREAKER_TEXT[breaker.state])}
                  data-testid="health-breaker-state"
                >
                  {t(`breakerState.${breaker.state}`)}
                </Badge>
                {breaker.state !== "closed" && breaker.openedAt !== null && (
                  <span className="text-muted-foreground">
                    {t("breakerOpenedAt", {
                      time: new Date(breaker.openedAt).toLocaleTimeString(),
                    })}
                  </span>
                )}
                {breaker.eventCount > 0 && (
                  <span className="text-muted-foreground" data-testid="health-breaker-rate">
                    {t("breakerFailureRate", {
                      rate: Math.round(breaker.failureRate),
                      events: breaker.eventCount,
                    })}
                  </span>
                )}
              </div>
            )}
            {rateBucket && (
              <div className="space-y-1" data-testid="health-rate-bucket">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t("rateBucketLabel")}:</span>
                  <span className="font-mono" data-testid="health-rate-bucket-available">
                    {t("rateBucketAvailable", {
                      available: Math.round(rateBucket.available * 10) / 10,
                      capacity: rateBucket.capacity,
                    })}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full transition-all",
                      breaker?.state === "open"
                        ? BREAKER_BG.open
                        : rateBucket.available < 1
                          ? BREAKER_BG.half_open
                          : BREAKER_BG.closed
                    )}
                    style={{
                      width: `${Math.max(
                        0,
                        Math.min(100, (rateBucket.available / rateBucket.capacity) * 100)
                      )}%`,
                    }}
                    aria-hidden
                  />
                </div>
                {rateBucket.available < 1 && rateBucket.nextRefillAt !== null && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("rateBucketNextRefill", {
                      seconds: Math.max(0, Math.round((rateBucket.nextRefillAt - now) / 1000)),
                    })}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card data-testid="health-detail-grid">
        <CardHeader className="pb-2 pt-3">
          <CardTitle className="text-sm font-medium">{t("uptime24h")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}
            data-testid="health-grid-cells"
          >
            {buckets.map((bucket, idx) => {
              const tint = STATE_TINT[bucket.state]
              const label = `${new Date(bucket.bucketStart).toLocaleTimeString()} — ${t(
                `state.${bucket.state}`
              )} (${bucket.eventCount})`
              return (
                <Tooltip key={idx}>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        "h-4 rounded-sm transition-colors",
                        tint,
                        bucket.state === "unknown" && "opacity-40"
                      )}
                      aria-label={label}
                      data-testid={`health-grid-cell-${idx}`}
                      data-state={bucket.state}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {label}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
            {(["running", "starting", "degraded", "down", "unknown"] as HealthCellState[]).map(
              (s) => (
                <span key={s} className="flex items-center gap-1">
                  <span className={cn("h-3 w-3 rounded-sm", STATE_TINT[s])} />
                  {t(`state.${s}`)}
                </span>
              )
            )}
          </div>
          {buckets.every((b) => b.state === "unknown") && (
            <div
              className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="health-grid-empty"
            >
              <AlertTriangleIcon className="h-3.5 w-3.5" />
              {t("noData")}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
