"use client"

/**
 * LogTimeline
 *
 * Compact horizontal bar showing log density over time,
 * color-coded by severity. Clickable regions to filter by time range.
 * Supports brush selection (click-and-drag) for zooming.
 * Includes level-specific mini-sparklines below the main bar.
 */

import { memo, useEffect, useMemo, useCallback, useState, useRef } from "react"
import { useTranslations, useLocale } from "next-intl"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { StructuredLogEntry } from "@cognia/logging"

export interface LogTimelineProps {
  logs: StructuredLogEntry[]
  className?: string
  /** Number of time buckets to divide the timeline into */
  bucketCount?: number
  /** Callback when a time range is selected (click or brush) */
  onTimeRangeClick?: (start: Date, end: Date) => void
  /** Callback when the active range is explicitly cleared (X chip click). */
  onClearRange?: () => void
  /** Currently selected bucket range (for highlighting) */
  selectedRange?: { start: Date; end: Date } | null
}

interface TimelineBucket {
  start: Date
  end: Date
  total: number
  error: number
  warn: number
  info: number
  other: number
}

function getBucketColor(bucket: TimelineBucket): string {
  if (bucket.total === 0) return "bg-muted/30"
  if (bucket.error > 0) return "bg-destructive"
  if (bucket.warn > 0) return "bg-warning"
  if (bucket.info > 0) return "bg-success"
  return "bg-chart-3"
}

function getBucketOpacity(bucket: TimelineBucket, maxCount: number): number {
  if (bucket.total === 0 || maxCount === 0) return 0.15
  return Math.max(0.2, Math.min(1, bucket.total / maxCount))
}

function isInRange(bucket: TimelineBucket, range: { start: Date; end: Date } | null): boolean {
  if (!range) return false
  return bucket.start >= range.start && bucket.end <= range.end
}

interface TimelineBucketTileProps {
  index: number
  total: number
  error: number
  warn: number
  startMs: number
  colorClass: string
  opacity: number
  isSelected: boolean
  isInBrush: boolean
  clickable: boolean
  onMouseDown: (idx: number) => void
  onMouseEnter: (idx: number) => void
  onMouseUp: () => void
  totalLabel: string
  errorsLabel: string
  warningsLabel: string
  locale: string
}

const TimelineBucketTile = memo(function TimelineBucketTile({
  index,
  total,
  error,
  warn,
  startMs,
  colorClass,
  opacity,
  isSelected,
  isInBrush,
  clickable,
  onMouseDown,
  onMouseEnter,
  onMouseUp,
  totalLabel,
  errorsLabel,
  warningsLabel,
  locale,
}: TimelineBucketTileProps) {
  const handleMouseDown = useCallback(() => onMouseDown(index), [onMouseDown, index])
  const handleMouseEnter = useCallback(() => onMouseEnter(index), [onMouseEnter, index])
  const startLabel = useMemo(
    () =>
      new Date(startMs).toLocaleTimeString(locale, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    [startMs, locale]
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            "flex-1 min-w-0 transition-all",
            colorClass,
            clickable && "cursor-pointer",
            isSelected && "ring-2 ring-primary ring-inset",
            isInBrush && "ring-1 ring-primary/70 ring-inset brightness-125",
            !isSelected && !isInBrush && "hover:ring-1 hover:ring-primary/50"
          )}
          style={{ opacity: isSelected || isInBrush ? Math.max(opacity, 0.6) : opacity }}
          onMouseDown={handleMouseDown}
          onMouseEnter={handleMouseEnter}
          onMouseUp={onMouseUp}
          aria-label={`${total} logs`}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <div className="space-y-0.5">
          <p className="font-medium">{startLabel}</p>
          <p>
            {totalLabel}: {total}
          </p>
          {error > 0 && (
            <p className="text-destructive">
              {errorsLabel}: {error}
            </p>
          )}
          {warn > 0 && (
            <p className="text-warning">
              {warningsLabel}: {warn}
            </p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
})

export function LogTimeline({
  logs,
  className,
  bucketCount = 60,
  onTimeRangeClick,
  onClearRange,
  selectedRange = null,
}: LogTimelineProps) {
  const t = useTranslations("logging")
  const locale = useLocale()
  const [dragStartIdx, setDragStartIdx] = useState<number | null>(null)
  const [dragCurrentIdx, setDragCurrentIdx] = useState<number | null>(null)
  const isDragging = useRef(false)

  // Mirror drag-state and the callback into refs so handleMouseUp can stay
  // identity-stable; otherwise every mouse-move re-creates it and invalidates
  // every memoized TimelineBucket below.
  const dragStartIdxRef = useRef<number | null>(null)
  const dragCurrentIdxRef = useRef<number | null>(null)
  const bucketsRef = useRef<TimelineBucket[]>([])
  const onTimeRangeClickRef = useRef(onTimeRangeClick)
  useEffect(() => {
    dragStartIdxRef.current = dragStartIdx
  }, [dragStartIdx])
  useEffect(() => {
    dragCurrentIdxRef.current = dragCurrentIdx
  }, [dragCurrentIdx])
  useEffect(() => {
    onTimeRangeClickRef.current = onTimeRangeClick
  }, [onTimeRangeClick])

  const buckets = useMemo((): TimelineBucket[] => {
    if (logs.length === 0) return []

    let minTs = Infinity
    let maxTs = -Infinity
    for (const log of logs) {
      const ts = new Date(log.timestamp).getTime()
      if (ts < minTs) minTs = ts
      if (ts > maxTs) maxTs = ts
    }
    const range = Math.max(maxTs - minTs, 1000)
    const bucketMs = range / bucketCount

    const result: TimelineBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
      start: new Date(minTs + i * bucketMs),
      end: new Date(minTs + (i + 1) * bucketMs),
      total: 0,
      error: 0,
      warn: 0,
      info: 0,
      other: 0,
    }))

    for (const log of logs) {
      const ts = new Date(log.timestamp).getTime()
      const idx = Math.min(Math.floor((ts - minTs) / bucketMs), bucketCount - 1)

      result[idx].total++
      if (log.level === "error" || log.level === "fatal") {
        result[idx].error++
      } else if (log.level === "warn") {
        result[idx].warn++
      } else if (log.level === "info") {
        result[idx].info++
      } else {
        result[idx].other++
      }
    }

    return result
  }, [logs, bucketCount])

  // Keep the latest buckets accessible from the identity-stable handleMouseUp.
  useEffect(() => {
    bucketsRef.current = buckets
  }, [buckets])

  const maxCount = useMemo(() => {
    let max = 1
    for (const b of buckets) {
      if (b.total > max) max = b.total
    }
    return max
  }, [buckets])

  // Max counts per level for mini-sparklines
  const maxPerLevel = useMemo(() => {
    let maxError = 1,
      maxWarn = 1,
      maxInfo = 1
    for (const b of buckets) {
      if (b.error > maxError) maxError = b.error
      if (b.warn > maxWarn) maxWarn = b.warn
      if (b.info > maxInfo) maxInfo = b.info
    }
    return { error: maxError, warn: maxWarn, info: maxInfo }
  }, [buckets])

  // Brush selection handlers — all three are identity-stable so the memoized
  // TimelineBucket children below only re-render when their own props change.
  const handleMouseDown = useCallback((idx: number) => {
    setDragStartIdx(idx)
    setDragCurrentIdx(idx)
    isDragging.current = true
  }, [])

  const handleMouseMove = useCallback((idx: number) => {
    if (isDragging.current) {
      setDragCurrentIdx(idx)
    }
  }, [])

  const handleMouseUp = useCallback(() => {
    const startRaw = dragStartIdxRef.current
    const currentRaw = dragCurrentIdxRef.current
    const cb = onTimeRangeClickRef.current
    const currentBuckets = bucketsRef.current
    if (
      isDragging.current &&
      startRaw !== null &&
      currentRaw !== null &&
      currentBuckets.length > 0
    ) {
      const startIdx = Math.min(startRaw, currentRaw)
      const endIdx = Math.max(startRaw, currentRaw)
      if (startIdx !== endIdx) {
        cb?.(currentBuckets[startIdx].start, currentBuckets[endIdx].end)
      } else {
        const b = currentBuckets[startIdx]
        cb?.(b.start, b.end)
      }
    }
    setDragStartIdx(null)
    setDragCurrentIdx(null)
    isDragging.current = false
  }, [])

  const brushRange = useMemo(() => {
    if (dragStartIdx === null || dragCurrentIdx === null) return null
    return {
      min: Math.min(dragStartIdx, dragCurrentIdx),
      max: Math.max(dragStartIdx, dragCurrentIdx),
    }
  }, [dragStartIdx, dragCurrentIdx])

  // Hoist i18n strings once per render so every TimelineBucketTile receives the
  // same primitive prop instances and short-circuits its memo comparison.
  const timelineLabels = useMemo(
    () => ({
      total: t("timeline.total"),
      errors: t("timeline.errors"),
      warnings: t("timeline.warnings"),
    }),
    [t]
  )

  // The timeline stays mounted whenever it is enabled, even when there are no
  // logs yet — that avoids a layout-shift flicker when filters momentarily
  // produce zero matches. The body below renders a quiet placeholder bar in
  // that case.
  const isEmpty = logs.length === 0

  const firstTime = buckets[0]?.start
  const lastTime = buckets[buckets.length - 1]?.end
  const hasErrors = !isEmpty && buckets.some((b) => b.error > 0)
  const hasWarns = !isEmpty && buckets.some((b) => b.warn > 0)

  return (
    <div
      data-testid="log-timeline-container"
      className={cn("px-3 py-2 sm:px-3 border-b bg-muted/10", className)}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs sm:text-[10px] text-muted-foreground font-medium">
          {t("timeline.title")}
        </span>
        {isEmpty && (
          <span className="text-xs sm:text-[10px] text-muted-foreground/70">
            {t("timeline.empty")}
          </span>
        )}
        {selectedRange && (
          <Button
            variant="ghost"
            size="sm"
            className="h-4 px-1 text-xs sm:text-[10px]"
            onClick={onClearRange}
          >
            <X className="h-2.5 w-2.5 mr-0.5" />
            {t("timeline.clear")}
          </Button>
        )}
        <div className="flex items-center gap-1.5 ml-auto">
          <div className="flex items-center gap-1">
            <div aria-hidden="true" className="h-2 w-2 rounded-sm bg-success" />
            <span className="text-xs sm:text-[10px] text-muted-foreground">{t("levels.info")}</span>
          </div>
          <div className="flex items-center gap-1">
            <div aria-hidden="true" className="h-2 w-2 rounded-sm bg-warning" />
            <span className="text-xs sm:text-[10px] text-muted-foreground">{t("levels.warn")}</span>
          </div>
          <div className="flex items-center gap-1">
            <div aria-hidden="true" className="h-2 w-2 rounded-sm bg-destructive" />
            <span className="text-xs sm:text-[10px] text-muted-foreground">
              {t("levels.error")}
            </span>
          </div>
        </div>
      </div>

      {/* Main density bar — wrapper provides ≥36px touch target on mobile */}
      <div
        className="flex items-center min-h-[36px] sm:min-h-0"
        onMouseLeave={handleMouseUp}
        onMouseUp={handleMouseUp}
      >
        <div className="flex gap-px h-6 w-full rounded overflow-hidden select-none motion-safe:transition-all">
          {isEmpty ? (
            <div
              data-testid="log-timeline-placeholder"
              className="flex-1 min-w-0 bg-muted/30"
              aria-hidden
            />
          ) : (
            buckets.map((bucket, i) => (
              <TimelineBucketTile
                key={i}
                index={i}
                total={bucket.total}
                error={bucket.error}
                warn={bucket.warn}
                startMs={bucket.start.getTime()}
                colorClass={getBucketColor(bucket)}
                opacity={getBucketOpacity(bucket, maxCount)}
                isSelected={isInRange(bucket, selectedRange)}
                isInBrush={brushRange ? i >= brushRange.min && i <= brushRange.max : false}
                clickable={Boolean(onTimeRangeClick)}
                onMouseDown={handleMouseDown}
                onMouseEnter={handleMouseMove}
                onMouseUp={handleMouseUp}
                totalLabel={timelineLabels.total}
                errorsLabel={timelineLabels.errors}
                warningsLabel={timelineLabels.warnings}
                locale={locale}
              />
            ))
          )}
        </div>
      </div>

      {/* Level-specific mini-sparklines (decorative) */}
      <div className="mt-0.5 space-y-px" aria-hidden="true">
        {hasErrors && (
          <div className="flex gap-px h-[3px] rounded overflow-hidden">
            {buckets.map((bucket, i) => (
              <div
                key={i}
                className="flex-1 min-w-0 bg-destructive motion-safe:transition-opacity"
                style={{
                  opacity:
                    bucket.error > 0 ? Math.max(0.3, bucket.error / maxPerLevel.error) : 0.05,
                }}
              />
            ))}
          </div>
        )}
        {hasWarns && (
          <div className="flex gap-px h-[3px] rounded overflow-hidden">
            {buckets.map((bucket, i) => (
              <div
                key={i}
                className="flex-1 min-w-0 bg-warning motion-safe:transition-opacity"
                style={{
                  opacity: bucket.warn > 0 ? Math.max(0.3, bucket.warn / maxPerLevel.warn) : 0.05,
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Time labels */}
      <div className="flex justify-between mt-0.5">
        <span className="text-xs sm:text-[10px] text-muted-foreground">
          {firstTime?.toLocaleTimeString(locale, {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        <span className="text-xs sm:text-[10px] text-muted-foreground">
          {lastTime?.toLocaleTimeString(locale, {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
    </div>
  )
}

export default LogTimeline
