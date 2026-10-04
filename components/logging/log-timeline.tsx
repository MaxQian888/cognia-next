"use client"

/**
 * LogTimeline
 *
 * Compact histogram of log volume over time. Each bucket is a stacked column:
 * its height is the bucket's volume, its segments the level mix. Clickable
 * regions filter by time range; click-and-drag brushes a range; the arrow keys
 * walk the buckets and Enter picks one. Level-specific mini-sparklines below
 * the bars mark where errors and warnings fall.
 *
 * Buckets used to be equal-height tiles painted in the *worst* level they
 * contained, faded by volume. One error in a bucket of two hundred infos
 * painted it red, so a store with a sprinkle of errors rendered a solid red
 * strip that said nothing about either volume or mix.
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

/** Stack order, bottom to top: the severe levels sit on the baseline where a
 * thin segment is still easy to see. */
const SEGMENTS = [
  { key: "error", className: "bg-destructive" },
  { key: "warn", className: "bg-warning" },
  { key: "info", className: "bg-success" },
  { key: "other", className: "bg-chart-3" },
] as const

/** Column height as a share of the bar, with a floor so a one-entry bucket
 * next to a thousand-entry one is still visible and clickable. */
function getBucketHeightPercent(total: number, maxCount: number): number {
  if (total === 0 || maxCount === 0) return 0
  return Math.max(8, Math.round((total / maxCount) * 100))
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
  info: number
  other: number
  startMs: number
  heightPercent: number
  isSelected: boolean
  isInBrush: boolean
  clickable: boolean
  /** Roving tab stop: only the active bucket is in the tab order. */
  tabbable: boolean
  onMouseDown: (idx: number) => void
  onMouseEnter: (idx: number) => void
  onMouseUp: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, idx: number) => void
  onFocus: (idx: number) => void
  registerRef: (idx: number, node: HTMLButtonElement | null) => void
  /** `{label}: {value}` in the user's language (the colon differs by locale). */
  fieldLabel: (label: string, value: number) => string
  totalLabel: string
  errorsLabel: string
  warningsLabel: string
  ariaLabel: (time: string, total: number, errors: number, warnings: number) => string
  locale: string
}

const TimelineBucketTile = memo(function TimelineBucketTile({
  index,
  total,
  error,
  warn,
  info,
  other,
  startMs,
  heightPercent,
  isSelected,
  isInBrush,
  clickable,
  tabbable,
  onMouseDown,
  onMouseEnter,
  onMouseUp,
  onKeyDown,
  onFocus,
  registerRef,
  fieldLabel,
  totalLabel,
  errorsLabel,
  warningsLabel,
  ariaLabel,
  locale,
}: TimelineBucketTileProps) {
  const handleMouseDown = useCallback(() => onMouseDown(index), [onMouseDown, index])
  const handleMouseEnter = useCallback(() => onMouseEnter(index), [onMouseEnter, index])
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => onKeyDown(event, index),
    [onKeyDown, index]
  )
  const handleFocus = useCallback(() => onFocus(index), [onFocus, index])
  const handleRef = useCallback(
    (node: HTMLButtonElement | null) => registerRef(index, node),
    [registerRef, index]
  )
  const counts = { error, warn, info, other }
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
        <Button
          ref={handleRef}
          type="button"
          variant="ghost"
          size="xs"
          tabIndex={tabbable ? 0 : -1}
          data-testid="log-timeline-bucket"
          data-total={total}
          className={cn(
            "flex h-full min-w-0 flex-1 flex-col-reverse items-stretch justify-start rounded-none p-0 transition-colors",
            "bg-muted/30 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            clickable && "cursor-pointer",
            isSelected && "bg-primary/10 ring-2 ring-primary ring-inset",
            isInBrush && "bg-primary/15 ring-1 ring-primary/70 ring-inset"
          )}
          onMouseDown={handleMouseDown}
          onMouseEnter={handleMouseEnter}
          onMouseUp={onMouseUp}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          aria-label={ariaLabel(startLabel, total, error, warn)}
        >
          {total > 0 && (
            <span
              aria-hidden
              className="flex w-full flex-col-reverse overflow-hidden"
              style={{ height: `${heightPercent}%` }}
            >
              {SEGMENTS.map((segment) =>
                counts[segment.key] > 0 ? (
                  <span
                    key={segment.key}
                    className={cn("w-full shrink-0", segment.className)}
                    style={{ height: `${(counts[segment.key] / total) * 100}%` }}
                  />
                ) : null
              )}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <div className="space-y-0.5">
          <p className="font-medium">{startLabel}</p>
          <p>{fieldLabel(totalLabel, total)}</p>
          {error > 0 && <p className="text-destructive">{fieldLabel(errorsLabel, error)}</p>}
          {warn > 0 && <p className="text-warning">{fieldLabel(warningsLabel, warn)}</p>}
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

  // ── Keyboard: one tab stop for the whole bar, arrows to walk it ──
  const [activeIdx, setActiveIdx] = useState(-1)
  const tileRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const registerTileRef = useCallback((idx: number, node: HTMLButtonElement | null) => {
    if (node) tileRefs.current.set(idx, node)
    else tileRefs.current.delete(idx)
  }, [])
  const handleTileFocus = useCallback((idx: number) => setActiveIdx(idx), [])
  const handleTileKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
      const count = bucketsRef.current.length
      if (count === 0) return
      let next: number | null = null
      if (event.key === "ArrowRight") next = Math.min(idx + 1, count - 1)
      else if (event.key === "ArrowLeft") next = Math.max(idx - 1, 0)
      else if (event.key === "Home") next = 0
      else if (event.key === "End") next = count - 1
      else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        const bucket = bucketsRef.current[idx]
        if (bucket) onTimeRangeClickRef.current?.(bucket.start, bucket.end)
        return
      }
      if (next === null) return
      event.preventDefault()
      setActiveIdx(next)
      tileRefs.current.get(next)?.focus()
    },
    []
  )

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
  const fieldLabel = useCallback(
    (label: string, value: number) => t("panel.fieldValue", { label, value }),
    [t]
  )
  const bucketAriaLabel = useCallback(
    (time: string, total: number, errors: number, warnings: number) =>
      t("timeline.bucketAria", { time, total, errors, warnings }),
    [t]
  )

  // The timeline stays mounted whenever it is enabled, even when there are no
  // logs yet — that avoids a layout-shift flicker when filters momentarily
  // produce zero matches. The body below renders a quiet placeholder bar in
  // that case.
  const isEmpty = logs.length === 0

  const firstTime = buckets[0]?.start
  const lastTime = buckets[buckets.length - 1]?.end
  const midTime =
    firstTime && lastTime ? new Date((firstTime.getTime() + lastTime.getTime()) / 2) : undefined
  // After a brush the list — and so this bar — is the selected range. Every
  // bucket is "in range" then, and ringing all sixty says nothing.
  const everyBucketSelected =
    selectedRange !== null &&
    buckets.length > 0 &&
    buckets.every((b) => isInRange(b, selectedRange))
  const rovingIdx = activeIdx >= 0 && activeIdx < buckets.length ? activeIdx : buckets.length - 1
  const formatAxis = (date: Date | undefined) =>
    date?.toLocaleTimeString(locale, { hour12: false, hour: "2-digit", minute: "2-digit" })
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
          <div className="flex items-center gap-1">
            <div aria-hidden="true" className="h-2 w-2 rounded-sm bg-chart-3" />
            <span className="text-xs sm:text-[10px] text-muted-foreground">
              {t("timeline.otherLevels")}
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
        <div
          role="group"
          aria-label={t("timeline.title")}
          className="flex gap-px h-8 w-full rounded overflow-hidden select-none"
        >
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
                info={bucket.info}
                other={bucket.other}
                startMs={bucket.start.getTime()}
                heightPercent={getBucketHeightPercent(bucket.total, maxCount)}
                isSelected={!everyBucketSelected && isInRange(bucket, selectedRange)}
                isInBrush={brushRange ? i >= brushRange.min && i <= brushRange.max : false}
                clickable={Boolean(onTimeRangeClick)}
                tabbable={i === rovingIdx}
                onMouseDown={handleMouseDown}
                onMouseEnter={handleMouseMove}
                onMouseUp={handleMouseUp}
                onKeyDown={handleTileKeyDown}
                onFocus={handleTileFocus}
                registerRef={registerTileRef}
                fieldLabel={fieldLabel}
                totalLabel={timelineLabels.total}
                errorsLabel={timelineLabels.errors}
                warningsLabel={timelineLabels.warnings}
                ariaLabel={bucketAriaLabel}
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
          {formatAxis(firstTime)}
        </span>
        <span className="text-xs sm:text-[10px] text-muted-foreground">{formatAxis(midTime)}</span>
        <span className="text-xs sm:text-[10px] text-muted-foreground">{formatAxis(lastTime)}</span>
      </div>
    </div>
  )
}

export default LogTimeline
