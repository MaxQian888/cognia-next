"use client"

/**
 * LogPanelStatsBar
 *
 * Extracted from log-panel.tsx — the ingest-rate / window line, the transport
 * health chip, and the transport and native-logging bands.
 *
 * The stats line is the trailing half of the level-filter row. Everything it
 * once restated is gone: the per-level counts and the total (the level tabs
 * badge them), and the "1–50 of 312" range with its pager — the list is
 * virtualized over the whole loaded window now, so there is no page to be on,
 * and the range only ever repeated the active tab's badge. What is left is
 * what the tabs cannot carry: the ingest rate, and whether the loaded window
 * is full.
 *
 * Transport health is no longer part of this line. `TransportHealthSummary`
 * is exported and the panel puts it beside Live / Refresh in the toolbar's
 * first row, where delivery health sits next to the controls that depend on
 * it. Its counts come from `summarizeTransportHealth`, the same function the
 * `/logs` header pill uses, so the two can no longer print different
 * denominators.
 */

import { useEffect, useId, useMemo, useState } from "react"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import { Activity, Info, Monitor, Settings2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { TransportHealthSnapshot } from "@cognia/logging"
import {
  summarizeTransportHealth,
  type UseTransportHealthResult,
} from "@/hooks/logging/use-transport-health"
import { NativeLogViewer } from "./native-log-viewer"

/** Where delivery, transports and native logging are configured. */
export const LOG_SETTINGS_HREF = "/settings?section=logs"

/**
 * How many problem transports may sit inline beside the summary chip. Healthy
 * transports never do: three green "q0 · just now" tiles used to occupy the
 * row, pushed it onto a second line at 1440px and onto three lines on a phone,
 * and the two transports that were actually degraded were the ones hidden
 * behind "+4" — while the header pill beside the page title read 5/7 in amber.
 */
const INLINE_ATTENTION_LIMIT = 2

type TransportTone = "success" | "warning" | "danger" | "muted"

/** Worst first — the order tiles are listed in, and the order "worst tone" is read from. */
const TONE_RANK: Record<TransportTone, number> = {
  danger: 0,
  warning: 1,
  muted: 2,
  success: 3,
}

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

type LoggingTranslator = ReturnType<typeof useTranslations<"logging">>

/**
 * Compact "how long ago" for the tiles and the transport detail. It used to
 * return hard-coded English ("just now", "5m ago") on a page that otherwise
 * renders in Chinese; the compact shape stays (the tiles are ~10px type), the
 * words come from the message bundle.
 */
function formatRelativeTime(isoDate: string | undefined, now: number, t: LoggingTranslator) {
  if (!isoDate) return "—"
  const then = new Date(isoDate).getTime()
  if (Number.isNaN(then)) return "—"
  const diffMs = Math.max(0, now - then)
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 5) return t("panel.relativeTime.justNow")
  if (diffSec < 60) return t("panel.relativeTime.seconds", { count: diffSec })
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return t("panel.relativeTime.minutes", { count: diffMin })
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return t("panel.relativeTime.hours", { count: diffHr })
  const diffDay = Math.floor(diffHr / 24)
  return t("panel.relativeTime.days", { count: diffDay })
}

/** The status vocabulary both transports and the native pipeline report in. */
const KNOWN_HEALTH_STATUSES = new Set(["healthy", "degraded", "offline", "inactive"])

function healthStatusLabel(status: string, t: LoggingTranslator): string {
  return KNOWN_HEALTH_STATUSES.has(status)
    ? t(`panel.healthStatus.${status as "healthy" | "degraded" | "offline" | "inactive"}`)
    : status
}

const KNOWN_STARTUP_MODES = new Set(["full", "fallback", "disabled", "unknown"])
const KNOWN_BRIDGE_STATES = new Set(["active", "inactive", "degraded"])

function startupModeLabel(mode: string, t: LoggingTranslator): string {
  return KNOWN_STARTUP_MODES.has(mode)
    ? t(`panel.nativeStartupMode.${mode as "full" | "fallback" | "disabled" | "unknown"}`)
    : mode
}

function bridgeStateLabel(state: string, t: LoggingTranslator): string {
  return KNOWN_BRIDGE_STATES.has(state)
    ? t(`panel.nativeBridgeState.${state as "active" | "inactive" | "degraded"}`)
    : state
}

export interface LogPanelStatsBarProps {
  logRate: number
  autoRefresh: boolean
  /**
   * Set when the stream returned as many entries as it was allowed to load
   * (measured before the search narrowed them). The panel is a window over
   * the newest `windowSize` entries — search, level and the time range all
   * filter inside it — and nothing said so: an error older than the window
   * simply did not exist as far as the page let on.
   */
  windowCapped?: boolean
  windowSize?: number
}

export function LogPanelStatsBar({
  logRate,
  autoRefresh,
  windowCapped = false,
  windowSize,
}: LogPanelStatsBarProps) {
  const t = useTranslations("logging")
  const format = useFormatter()
  const pulseColor = logRate < 10 ? "bg-success" : logRate <= 100 ? "bg-warning" : "bg-destructive"
  const showRate = logRate > 0
  const showCap = windowCapped && Boolean(windowSize)
  if (!showRate && !showCap) return null

  return (
    <div
      data-testid="log-panel-stats-bar"
      className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs"
    >
      {/* Ingest rate — hidden on narrow shells, where every pixel of the
          level row belongs to the tabs. */}
      {showRate && (
        <span
          className="hidden items-center gap-1 text-muted-foreground lg:flex"
          data-testid="log-panel-log-rate"
        >
          {autoRefresh && (
            // Decorative pulse; the rate beside it is the information, and
            // the title names the pulse for a pointer. A `<span>` cannot
            // carry an `aria-label` (it has no role), which is what it did.
            <span
              aria-hidden
              className={cn(
                "inline-flex h-2 w-2 rounded-full motion-safe:animate-pulse",
                pulseColor
              )}
              title={t("panel.logRatePulse")}
            />
          )}
          <Activity className="h-3 w-3" aria-hidden />
          {t("panel.logRateValue", { rate: format.number(logRate) })}
        </span>
      )}

      {showCap ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-5 text-muted-foreground"
              data-testid="log-panel-window-cap"
              aria-label={t("panel.windowCapped", { count: windowSize! })}
            >
              <Info className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            {t("panel.windowCapped", { count: windowSize! })}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

interface TransportHealthTileProps {
  /** Stable id for test hooks — the transport name, or `native`. */
  id: string
  label: string
  tone: TransportTone
  status: string
  queueDepth?: number
  droppedEntries?: number
  lastEventAt?: string
  onClick: () => void
  icon?: React.ReactNode
}

function TransportHealthTile({
  id,
  label,
  tone,
  status,
  queueDepth,
  droppedEntries,
  lastEventAt,
  onClick,
  icon,
}: TransportHealthTileProps) {
  const t = useTranslations("logging")
  const now = useNow()
  const relative = formatRelativeTime(lastEventAt, now, t)
  const statusLabel = healthStatusLabel(status, t)
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-testid={`transport-tile-${id}`}
      data-tone={tone}
      aria-label={
        typeof queueDepth === "number"
          ? t("panel.transportTileAria", { name: label, status: statusLabel, queue: queueDepth })
          : t("panel.nativeTileAria", { status: statusLabel })
      }
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
        <span
          className="tabular-nums"
          title={t("panel.transportQueueDepthTitle", { count: queueDepth })}
        >
          {t("panel.transportQueueShort", { count: queueDepth })}
        </span>
      )}
      {typeof droppedEntries === "number" && droppedEntries > 0 && (
        <span
          className="tabular-nums text-destructive"
          title={t("panel.transportDroppedTitle", { count: droppedEntries })}
        >
          {t("panel.transportDroppedShort", { count: droppedEntries })}
        </span>
      )}
      <span className="text-muted-foreground text-[9px]" title={lastEventAt}>
        {relative}
      </span>
      <span className="sr-only">{t("statusSr", { status: statusLabel })}</span>
    </Button>
  )
}

export interface TransportHealthSummaryProps {
  healthByTransport: Record<string, TransportHealthSnapshot>
  nativeLogging: UseTransportHealthResult["nativeLogging"]
  onTransportClick: (name: string) => void
  onNativeLoggingClick: () => void
}

/**
 * One chip for the whole delivery pipeline, plus the transports that need a
 * look. The chip opens every tile, worst first; a problem transport also sits
 * inline beside it so the amber in the page header has an answer on the row
 * the user is already reading.
 */
export function TransportHealthSummary({
  healthByTransport,
  nativeLogging,
  onTransportClick,
  onNativeLoggingClick,
}: TransportHealthSummaryProps) {
  const t = useTranslations("logging")
  const [open, setOpen] = useState(false)
  const tiles = useMemo<(TransportHealthTileProps & { id: string })[]>(() => {
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
      onClick: () => onTransportClick(health.transport),
    }))
    if (nativeLogging.runtime === "tauri") {
      transportTiles.push({
        id: "native",
        label: t("panel.nativeTileLabel"),
        tone: nativeStatusToTone(nativeLogging.status),
        status: nativeLogging.status,
        onClick: onNativeLoggingClick,
        icon: <Monitor />,
      })
    }
    // Stable within a tone so the list does not reshuffle on every poll.
    return transportTiles.sort(
      (a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || a.label.localeCompare(b.label)
    )
  }, [healthByTransport, nativeLogging, onTransportClick, onNativeLoggingClick, t])

  if (tiles.length === 0) return null

  const attention = tiles.filter((tile) => tile.tone === "danger" || tile.tone === "warning")
  const inline = attention.slice(0, INLINE_ATTENTION_LIMIT)
  // The same counts the `/logs` header pill prints — one function, one denominator.
  const { healthy, total } = summarizeTransportHealth(healthByTransport, nativeLogging)
  const worstTone = tiles[0].tone
  const summaryLabel = t("panel.transportSummaryAria", { healthy, total })

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="transport-health-summary">
      {/* On a phone the summary chip alone carries the alarm (it takes the
          worst tone); the named tiles would cost the list a whole row. */}
      {inline.length > 0 && (
        <span className="hidden flex-wrap items-center gap-1.5 sm:flex">
          {inline.map((tile) => (
            <TransportHealthTile key={tile.id} {...tile} />
          ))}
        </span>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="transport-health-summary-trigger"
            data-tone={worstTone}
            aria-label={summaryLabel}
            title={summaryLabel}
            className="h-6 gap-1.5 px-2 text-[10px] text-muted-foreground motion-safe:transition-colors"
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                TRANSPORT_TILE_DOT_CLASSES[worstTone]
              )}
            />
            <span className="hidden sm:inline">{t("panel.transportSummaryLabel")}</span>
            <span className="font-mono tabular-nums">
              {t("panel.transportSummaryCount", { healthy, total })}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto min-w-56 p-2">
          <div className="mb-1.5 px-0.5 text-xs font-medium">
            {t("panel.transportSummaryTitle")}
          </div>
          <div className="flex flex-col gap-1.5" data-testid="transport-health-tile-group">
            {tiles.map((tile) => (
              <TransportHealthTile
                key={tile.id}
                {...tile}
                onClick={() => {
                  setOpen(false)
                  tile.onClick()
                }}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
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
      <span className="text-[10px] text-muted-foreground" role="img" aria-label={ariaLabel}>
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
          <span>{t("panel.transportDetailsTitle", { name: health.transport })}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {healthStatusLabel(health.status, t)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" asChild>
            <Link href={LOG_SETTINGS_HREF} data-testid="transport-detail-settings">
              <Settings2 className="h-3.5 w-3.5" aria-hidden />
              {t("panel.openLogSettings")}
            </Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("panel.closeTransportDetails")}
          </Button>
        </div>
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
          value={formatRelativeTime(health.lastFailureAt, now, t)}
          tone={health.lastFailureAt ? "warning" : "muted"}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">
            {t("panel.fieldValue", {
              label: lastSuccessLabel,
              value: formatRelativeTime(health.lastSuccessAt, now, t),
            })}
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
}

/**
 * The native pipeline's band: its readiness, and the native log itself.
 *
 * "View native diagnostics" used to set the list's source to Tauri and type
 * `native_logging` into the search box — a guess at which frontend entries
 * might mention the pipeline. The pipeline writes its own files, so the band
 * now reads them (`NativeLogViewer`, the same viewer Settings → Logs shows)
 * and links to the settings that control them.
 */
export function NativeLoggingDetail({ nativeLogging, onClose }: NativeLoggingDetailProps) {
  const t = useTranslations("logging")
  const field = (label: string, value: string) => t("panel.fieldValue", { label, value })

  return (
    <div
      className="border-b bg-muted/10 px-3 py-3 text-xs space-y-3"
      data-testid="native-logging-detail"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">{t("panel.nativeLoggingDetails")}</div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" asChild>
            <Link href={LOG_SETTINGS_HREF} data-testid="native-detail-settings">
              <Settings2 className="h-3.5 w-3.5" aria-hidden />
              {t("panel.openLogSettings")}
            </Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("panel.closeTransportDetails")}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          {field(t("panel.nativeLoggingStatus"), healthStatusLabel(nativeLogging.status, t))}
        </span>
        <span>
          {field(t("panel.nativeLoggingMode"), startupModeLabel(nativeLogging.startupMode, t))}
        </span>
        <span>
          {field(t("panel.nativeLoggingBridge"), bridgeStateLabel(nativeLogging.bridgeState, t))}
        </span>
        <span>
          {field(
            t("panel.nativeLoggingTargets"),
            nativeLogging.activeTargets.length > 0
              ? nativeLogging.activeTargets.join(", ")
              : t("panel.nativeLoggingNoTargets")
          )}
        </span>
        {nativeLogging.fallbackReason?.message && (
          <span>
            {field(t("panel.nativeLoggingFallbackReason"), nativeLogging.fallbackReason.message)}
          </span>
        )}
        {nativeLogging.bridgeLastError && (
          <span>
            {field(t("panel.nativeLoggingLastBridgeError"), nativeLogging.bridgeLastError)}
          </span>
        )}
      </div>
      <NativeLogViewer />
    </div>
  )
}

export default LogPanelStatsBar
