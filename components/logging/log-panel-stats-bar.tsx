"use client"

/**
 * LogPanelStatsBar
 *
 * Extracted from log-panel.tsx — stats summary, transport health, native logging panels.
 * Pagination is merged into this single compact bar (replaces log-panel-pagination.tsx).
 */

import { useEffect, useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Activity, ChevronLeft, ChevronRight, Monitor } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { LEVEL_THEME } from "@cognia/logging/level-theme"
import type { LogLevel, TransportHealthSnapshot } from "@cognia/logging"
import type { UseTransportHealthResult } from "@/hooks/logging"

const TRANSPORT_TILE_VISIBLE_LIMIT = 3

type TransportTone = "success" | "warning" | "danger" | "muted"

const TRANSPORT_TILE_TONE_CLASSES: Record<TransportTone, string> = {
  success: "border-success/40 bg-success/5 text-success hover:bg-success/10",
  warning: "border-warning/40 bg-warning/5 text-warning hover:bg-warning/10",
  danger: "border-destructive/50 bg-destructive/5 text-destructive hover:bg-destructive/10",
  muted: "border-border bg-muted/30 text-muted-foreground hover:bg-muted/40",
}
const TRANSPORT_TILE_DOT_CLASSES: Record<TransportTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/50",
}

function transportStatusToTone(status: TransportHealthSnapshot["status"]): TransportTone {
  switch (status) {
    case "healthy":
      return "success"
    case "degraded":
      return "warning"
    case "offline":
      return "danger"
    default:
      return "muted"
  }
}

function nativeStatusToTone(
  status: UseTransportHealthResult["nativeLogging"]["status"]
): TransportTone {
  switch (status) {
    case "healthy":
      return "success"
    case "degraded":
      return "warning"
    case "inactive":
      return "muted"
    default:
      return "muted"
  }
}

function useNow(tickIntervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tickIntervalMs)
    return () => clearInterval(timer)
  }, [tickIntervalMs])
  return now
}

function formatRelativeTime(isoDate: string | undefined, now: number): string {
  if (!isoDate) return "—"
  const then = new Date(isoDate).getTime()
  if (Number.isNaN(then)) return "—"
  const diffMs = Math.max(0, now - then)
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 5) return "just now"
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

export interface LogPanelStatsBarProps {
  filteredCount: number
  totalCount: number
  stats: { byLevel: Record<LogLevel, number> }
  logRate: number
  autoRefresh: boolean
  healthByTransport: Record<string, TransportHealthSnapshot>
  nativeLogging: UseTransportHealthResult["nativeLogging"]
  onTransportClick: (name: string) => void
  onNativeLoggingClick: () => void
  // Pagination props (merged)
  currentPage: number
  totalPages: number
  pageSize: number
  pageSizeOptions: readonly number[]
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}

export function LogPanelStatsBar({
  filteredCount,
  totalCount,
  stats,
  logRate,
  autoRefresh,
  healthByTransport,
  nativeLogging,
  onTransportClick,
  onNativeLoggingClick,
  currentPage,
  totalPages,
  pageSize,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
}: LogPanelStatsBarProps) {
  const t = useTranslations("logging")
  const pulseColor = logRate < 10 ? "bg-success" : logRate <= 100 ? "bg-warning" : "bg-destructive"

  const start = filteredCount === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const end = Math.min(currentPage * pageSize, filteredCount)

  return (
    <div
      data-testid="log-panel-stats-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-b bg-muted/20 text-xs"
    >
      {/* Left: showing range + page size select */}
      <span className="text-muted-foreground shrink-0">
        {t("panel.showingRange", { start, end, total: filteredCount })}
        {filteredCount !== totalCount && (
          <span className="text-muted-foreground/70"> / {totalCount}</span>
        )}
      </span>
      <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
        <SelectTrigger aria-label={t("panel.pageSize")} className="h-6 w-[72px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          <SelectGroup>
            {pageSizeOptions.map((opt) => (
              <SelectItem key={opt} value={String(opt)} className="text-xs">
                {opt}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {/* Separator */}
      <span className="text-muted-foreground/40 select-none">|</span>

      {/* Center: level counts (non-zero) */}
      {Object.entries(stats.byLevel).map(([level, count]) => {
        if (count === 0) return null
        const theme = LEVEL_THEME[level as LogLevel]
        return (
          <span key={level} className={cn("flex items-center gap-0.5 shrink-0", theme.iconColor)}>
            {t(`levels.${level}`)}: <span className="font-medium">{count}</span>
          </span>
        )
      })}

      {/* Right side pushed with ml-auto */}
      <span className="ml-auto flex items-center gap-x-2 gap-y-1 flex-wrap justify-end">
        {/* Log rate + pulse */}
        {logRate > 0 && (
          <span className="flex items-center gap-1 text-muted-foreground">
            {autoRefresh && (
              <span
                className={cn(
                  "inline-flex h-2 w-2 rounded-full motion-safe:animate-pulse",
                  pulseColor
                )}
                title={t("panel.logRatePulse")}
                aria-label={t("panel.logRatePulse")}
              />
            )}
            <Activity className="h-3 w-3" />~{logRate} {t("panel.logsPerMin")}
          </span>
        )}

        {/* Transport health tiles (with overflow chip) */}
        <TransportHealthTileGroup
          healthByTransport={healthByTransport}
          nativeLogging={nativeLogging}
          onTransportClick={onTransportClick}
          onNativeLoggingClick={onNativeLoggingClick}
        />

        {/* Pagination prev / page indicator / next */}
        {totalPages > 1 && (
          <>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t("panel.previousPage")}
              disabled={currentPage <= 1}
              onClick={() => onPageChange(currentPage - 1)}
              className="h-5 w-5"
            >
              <ChevronLeft className="size-3" />
            </Button>
            <span className="tabular-nums text-muted-foreground">
              {currentPage} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t("panel.nextPage")}
              disabled={currentPage >= totalPages}
              onClick={() => onPageChange(currentPage + 1)}
              className="h-5 w-5"
            >
              <ChevronRight className="size-3" />
            </Button>
          </>
        )}
      </span>
    </div>
  )
}

interface TransportHealthTileProps {
  label: string
  tone: TransportTone
  status: string
  queueDepth?: number
  droppedEntries?: number
  lastEventAt?: string
  ariaLabel: string
  onClick: () => void
  icon?: React.ReactNode
}

function TransportHealthTile({
  label,
  tone,
  status,
  queueDepth,
  droppedEntries,
  lastEventAt,
  ariaLabel,
  onClick,
  icon,
}: TransportHealthTileProps) {
  const t = useTranslations("logging")
  const now = useNow()
  const relative = formatRelativeTime(lastEventAt, now)
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-testid={`transport-tile-${label}`}
      data-tone={tone}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "h-6 gap-1.5 px-2 text-[10px] leading-none motion-safe:transition-colors",
        TRANSPORT_TILE_TONE_CLASSES[tone]
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full shrink-0", TRANSPORT_TILE_DOT_CLASSES[tone])}
        aria-hidden
      />
      {icon && (
        <span className="shrink-0 [&_svg]:size-3" aria-hidden>
          {icon}
        </span>
      )}
      <span className="font-medium truncate max-w-[80px]">{label}</span>
      <span className="text-muted-foreground tabular-nums" aria-hidden>
        ·
      </span>
      {typeof queueDepth === "number" && (
        <span className="tabular-nums" title={`queue depth: ${queueDepth}`}>
          q{queueDepth}
        </span>
      )}
      {typeof droppedEntries === "number" && droppedEntries > 0 && (
        <span className="tabular-nums text-destructive" title={`dropped: ${droppedEntries}`}>
          d{droppedEntries}
        </span>
      )}
      <span className="text-muted-foreground text-[9px]" title={lastEventAt}>
        {relative}
      </span>
      <span className="sr-only">{t("statusSr", { status })}</span>
    </Button>
  )
}

interface TransportHealthTileGroupProps {
  healthByTransport: Record<string, TransportHealthSnapshot>
  nativeLogging: UseTransportHealthResult["nativeLogging"]
  onTransportClick: (name: string) => void
  onNativeLoggingClick: () => void
}

function TransportHealthTileGroup({
  healthByTransport,
  nativeLogging,
  onTransportClick,
  onNativeLoggingClick,
}: TransportHealthTileGroupProps) {
  const t = useTranslations("logging")
  const allTiles = useMemo<(TransportHealthTileProps & { id: string })[]>(() => {
    const transportTiles: (TransportHealthTileProps & { id: string })[] = Object.values(
      healthByTransport
    ).map((health) => ({
      id: health.transport,
      label: health.transport,
      tone: transportStatusToTone(health.status),
      status: health.status,
      queueDepth: health.queueDepth,
      droppedEntries: health.droppedEntries,
      lastEventAt: health.lastSuccessAt ?? health.lastFailureAt ?? health.updatedAt,
      ariaLabel: `${health.transport}:${health.status} q=${health.queueDepth}`,
      onClick: () => onTransportClick(health.transport),
    }))
    if (nativeLogging.runtime === "tauri") {
      transportTiles.push({
        id: "native",
        label: "native",
        tone: nativeStatusToTone(nativeLogging.status),
        status: nativeLogging.status,
        ariaLabel: `native:${nativeLogging.status} bridge=${nativeLogging.bridgeState}`,
        onClick: onNativeLoggingClick,
        icon: <Monitor />,
      })
    }
    return transportTiles
  }, [healthByTransport, nativeLogging, onTransportClick, onNativeLoggingClick])

  if (allTiles.length === 0) return null

  const visible = allTiles.slice(0, TRANSPORT_TILE_VISIBLE_LIMIT)
  const overflow = allTiles.slice(TRANSPORT_TILE_VISIBLE_LIMIT)
  const overflowLabel = t("panel.transportHealthOverflow")

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="transport-health-tile-group">
      {visible.map((tile) => (
        <TransportHealthTile key={tile.id} {...tile} />
      ))}
      {overflow.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="transport-tile-overflow"
              aria-label={`${overflowLabel} (+${overflow.length})`}
              className="h-6 gap-1 px-2 text-[10px] text-muted-foreground motion-safe:transition-colors"
            >
              +{overflow.length}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-2">
            <div className="flex flex-col gap-1.5">
              {overflow.map((tile) => (
                <TransportHealthTile key={tile.id} {...tile} />
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

export interface TransportHealthDetailProps {
  health: TransportHealthSnapshot
  history?: number[]
  onClose: () => void
  onViewDiagnostics: () => void
}

function Sparkline({ data, ariaLabel }: { data: number[]; ariaLabel: string }) {
  const pathId = useId()
  const path = useMemo(() => {
    if (data.length < 2) return null
    const max = Math.max(...data, 1)
    const width = 80
    const height = 20
    const step = width / Math.max(1, data.length - 1)
    return data
      .map((value, index) => {
        const x = index * step
        const y = height - (value / max) * height
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(" ")
  }, [data])

  if (!path) {
    return (
      <span className="text-[10px] text-muted-foreground" aria-label={ariaLabel}>
        —
      </span>
    )
  }

  return (
    <svg
      width="80"
      height="20"
      viewBox="0 0 80 20"
      role="img"
      aria-label={ariaLabel}
      data-testid="transport-health-sparkline"
      className="text-primary"
    >
      <path id={pathId} d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function TransportHealthDetail({
  health,
  history,
  onClose,
  onViewDiagnostics,
}: TransportHealthDetailProps) {
  const t = useTranslations("logging")
  const now = useNow()
  const tone = transportStatusToTone(health.status)
  const lastSuccessLabel = t("panel.transportLastSuccess")
  const sparklineLabel = t("panel.transportQueueHistory")

  return (
    <div className="border-b bg-muted/10 px-3 py-3 text-xs space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <span
            className={cn("h-2 w-2 rounded-full", TRANSPORT_TILE_DOT_CLASSES[tone])}
            aria-hidden
          />
          <span>{t("panel.transportDetails")}</span>
          <span>: {health.transport}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {health.status}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("panel.closeTransportDetails")}
        </Button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        <MetricCell
          label={t("panel.transportQueueDepth")}
          value={health.queueDepth.toLocaleString()}
        />
        <MetricCell
          label={t("panel.transportRetries")}
          value={health.retryCount.toLocaleString()}
        />
        <MetricCell
          label={t("panel.transportDropped")}
          value={health.droppedEntries.toLocaleString()}
          tone={health.droppedEntries > 0 ? "danger" : "muted"}
        />
        <MetricCell
          label={t("panel.transportLastFailure")}
          value={formatRelativeTime(health.lastFailureAt, now)}
          tone={health.lastFailureAt ? "warning" : "muted"}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">
            {lastSuccessLabel}: {formatRelativeTime(health.lastSuccessAt, now)}
          </span>
          {health.lastError && (
            <span className="text-destructive truncate max-w-md" title={health.lastError}>
              {health.lastError}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {history && history.length > 0 && <Sparkline data={history} ariaLabel={sparklineLabel} />}
          <Button variant="outline" size="sm" onClick={onViewDiagnostics}>
            {t("panel.viewDiagnostics")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function MetricCell({
  label,
  value,
  tone = "muted",
}: {
  label: string
  value: string
  tone?: TransportTone
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1.5 flex flex-col gap-0.5",
        tone === "danger" && "border-destructive/40 bg-destructive/5",
        tone === "warning" && "border-warning/40 bg-warning/5",
        tone === "success" && "border-success/40 bg-success/5",
        tone === "muted" && "border-border bg-background/40"
      )}
    >
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  )
}

export interface NativeLoggingDetailProps {
  nativeLogging: UseTransportHealthResult["nativeLogging"]
  onClose: () => void
  onViewDiagnostics: () => void
}

export function NativeLoggingDetail({
  nativeLogging,
  onClose,
  onViewDiagnostics,
}: NativeLoggingDetailProps) {
  const t = useTranslations("logging")

  return (
    <div className="border-b bg-muted/10 px-3 py-3 text-xs space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">{t("panel.nativeLoggingDetails")}</div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("panel.closeTransportDetails")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span>
          {t("panel.nativeLoggingStatus")}: {nativeLogging.status}
        </span>
        <span>
          {t("panel.nativeLoggingMode")}: {nativeLogging.startupMode}
        </span>
        <span>
          {t("panel.nativeLoggingBridge")}: {nativeLogging.bridgeState}
        </span>
        <span>
          {t("panel.nativeLoggingTargets")}:{" "}
          {nativeLogging.activeTargets.length > 0
            ? nativeLogging.activeTargets.join(", ")
            : t("panel.nativeLoggingNoTargets")}
        </span>
        {nativeLogging.fallbackReason?.message && (
          <span>
            {t("panel.nativeLoggingFallbackReason")}: {nativeLogging.fallbackReason.message}
          </span>
        )}
        {nativeLogging.bridgeLastError && (
          <span>
            {t("panel.nativeLoggingLastBridgeError")}: {nativeLogging.bridgeLastError}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={onViewDiagnostics}>
          {t("panel.viewNativeDiagnostics")}
        </Button>
      </div>
    </div>
  )
}

export default LogPanelStatsBar
