"use client"

/**
 * VirtualizedLogList
 *
 * Extracted from log-panel.tsx — virtualized log list with @tanstack/react-virtual.
 *
 * A `listbox` of `option` rows with a roving tab stop: the panel's keyboard
 * cursor (`focusedIndex`) decides which row Tab lands on, and while focus is
 * inside the list the cursor carries DOM focus with it, so j / k / the arrows
 * move what a screen reader announces and not only a highlight. The trace
 * grouping that used to live here (`groupByTraceId` → `TraceGroup`) is gone:
 * no host ever turned it on, it bypassed the virtualizer, and the panel's
 * trace view is the grouped reading of the same rows.
 */

import React, { useEffect, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useTranslations } from "next-intl"
import { AlertCircle, ChevronDown, ChevronRight, Layers, RefreshCw } from "lucide-react"
import { Empty, EmptyTitle } from "@/components/ui/empty"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { MemoizedLogEntry } from "./log-entry"
import type { Density } from "@/hooks/logging/use-log-panel-filters"
import type { StructuredLogEntry } from "@cognia/logging"

export const ESTIMATED_LOG_HEIGHT = 44

const DENSITY_ROW_HEIGHTS: Record<Density, number> = {
  compact: 28,
  comfortable: 44,
  spacious: 60,
}
const SKELETON_ROW_COUNT = 8

export interface VirtualizedLogListEmptyContext {
  /** Already-translated descriptions of the active filters ("Level: Error"). */
  activeFilterLabels: string[]
  onClearFilters?: () => void
  onOpenPresets?: () => void
  /**
   * The size of the loaded window when it is full. An empty result over a full
   * window is not "nothing matches" — it is "nothing among the newest N
   * matches", and the empty state says so.
   */
  windowCappedCount?: number
}

export interface VirtualizedLogListProps {
  scrollRef: React.RefObject<HTMLDivElement | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  isLoading: boolean
  error: Error | null
  filteredLogs: StructuredLogEntry[]
  expandedIds: Set<string>
  toggleExpanded: (id: string) => void
  searchQuery: string
  useRegex: boolean
  bookmarkedIds: Set<string>
  toggleBookmark: (id: string) => void
  handleSelectLog: (log: StructuredLogEntry) => void
  handleFocusTrace: (traceId: string, log: StructuredLogEntry) => void
  handleFocusSession: (sessionId: string, log: StructuredLogEntry) => void
  /** Id of the log whose detail panel is open — highlights the matching row. */
  selectedLogId?: string | null
  /** A row's primary action (click / Enter). See `LogEntryProps.onActivate`. */
  onActivateRow?: (log: StructuredLogEntry, index: number) => void
  /**
   * Index of the keyboard cursor (j / k / arrows) within `filteredLogs`, or -1.
   * The panel tracked it all along, and `b` / `o` / Enter acted on it, but no
   * row showed it and the list never scrolled to it — the shortcuts operated
   * on an entry the user could not see.
   */
  focusedIndex?: number
  /** A row received focus (click, Tab) — the host moves its cursor there. */
  onFocusRow?: (index: number) => void
  t: ReturnType<typeof useTranslations>
  /** Retries the current query when the list fails to load. */
  onRetry?: () => void
  /** Describes the active filters so the empty state can reference them. */
  emptyStateContext?: VirtualizedLogListEmptyContext
  /** Visual density — controls row height and entry padding. */
  density?: Density
}

export function VirtualizedLogList({
  scrollRef,
  containerRef,
  isLoading,
  error,
  filteredLogs,
  expandedIds,
  toggleExpanded,
  searchQuery,
  useRegex,
  bookmarkedIds,
  toggleBookmark,
  handleSelectLog,
  handleFocusTrace,
  handleFocusSession,
  selectedLogId = null,
  onActivateRow,
  focusedIndex = -1,
  onFocusRow,
  t,
  onRetry,
  emptyStateContext,
  density = "comfortable",
}: VirtualizedLogListProps) {
  const rowHeight = DENSITY_ROW_HEIGHTS[density]
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    // Key the measurement cache by log id, the same key React renders the row
    // under. The default key is the INDEX, and this list is newest-first: every
    // arriving entry shifts all rows down one index while the mounted row
    // elements (keyed by id) keep their size, so ResizeObserver never fires to
    // correct the cache. Each row then inherited its predecessor's measured
    // height — a tall wrapped agent.trace row was laid out at a one-line
    // height and the next row painted over its message (with a matching blank
    // gap wherever a short row inherited a tall height).
    getItemKey: (index) => filteredLogs[index]?.id ?? index,
    overscan: 10,
  })

  // Keep the cursor on screen. `auto` only scrolls when the row is out of
  // view, so stepping through visible rows does not jolt the list. When focus
  // is already inside the list, it follows the cursor (roving tabindex) once
  // the virtualizer has mounted the row.
  useEffect(() => {
    if (focusedIndex < 0 || focusedIndex >= filteredLogs.length) return
    virtualizer.scrollToIndex(focusedIndex, { align: "auto" })
    const list = containerRef.current
    if (!list || typeof document === "undefined") return
    if (!list.contains(document.activeElement)) return
    const frame = requestAnimationFrame(() => {
      const row = list.querySelector<HTMLElement>(`[role="option"][data-index="${focusedIndex}"]`)
      if (row && document.activeElement !== row && !row.contains(document.activeElement)) {
        row.focus({ preventScroll: true })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [focusedIndex, filteredLogs.length, virtualizer, containerRef])

  if (isLoading && filteredLogs.length === 0) {
    return (
      <div
        className="flex-1 overflow-auto min-h-0"
        ref={scrollRef}
        data-testid="log-virtualized-list-loading"
        aria-busy="true"
        aria-label={t("panel.loadingLogs")}
      >
        <div className="flex flex-col">
          {Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
            <div
              key={index}
              data-testid="log-virtualized-list-skeleton-row"
              className="flex items-center gap-3 border-b border-border/30 px-3"
              style={{ height: rowHeight }}
            >
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3" style={{ width: `${40 + (index % 4) * 15}%` }} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        scrollRef={scrollRef}
        error={error}
        onRetry={onRetry}
        title={t("panel.errorLoading")}
        retryLabel={t("virtualizedList.retry")}
        detailsLabel={t("virtualizedList.details")}
      />
    )
  }

  if (filteredLogs.length === 0) {
    const activeLabels = emptyStateContext?.activeFilterLabels ?? []
    const cappedCount = emptyStateContext?.windowCappedCount
    return (
      <div
        className="flex-1 overflow-auto min-h-0"
        ref={scrollRef}
        data-testid="log-virtualized-list-empty"
      >
        <Empty className="py-12 border-0">
          <div className="flex flex-col items-center gap-3 max-w-md">
            <Layers className="h-10 w-10 text-muted-foreground/40" />
            <EmptyTitle className="text-sm font-medium">{t("panel.emptyStateTitle")}</EmptyTitle>
            {activeLabels.length > 0 ? (
              <>
                <p className="text-xs text-muted-foreground text-center">
                  {t("panel.emptyStateFilterPrefix")}
                </p>
                <div
                  data-testid="log-virtualized-list-empty-filters"
                  className="flex flex-wrap justify-center gap-1"
                >
                  {activeLabels.map((label) => (
                    <Badge
                      key={label}
                      variant="outline"
                      className="bg-muted/40 px-2 py-0.5 text-xs sm:text-[10px]"
                    >
                      {label}
                    </Badge>
                  ))}
                </div>
                {cappedCount ? (
                  <p
                    className="text-xs text-muted-foreground text-center"
                    data-testid="log-virtualized-list-empty-window"
                  >
                    {t("panel.emptyStateWindowCapped", { count: cappedCount })}
                  </p>
                ) : null}
                <div className="flex items-center gap-2 mt-1">
                  {emptyStateContext?.onClearFilters && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={emptyStateContext.onClearFilters}
                      data-testid="log-virtualized-list-empty-clear"
                    >
                      {t("panel.emptyStateClearFilters")}
                    </Button>
                  )}
                  {emptyStateContext?.onOpenPresets && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={emptyStateContext.onOpenPresets}
                      data-testid="log-virtualized-list-empty-presets"
                    >
                      {t("panel.emptyStateOpenPresets")}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground text-center max-w-xs">
                {t("panel.emptyStateDescription")}
              </p>
            )}
          </div>
        </Empty>
      </div>
    )
  }

  const virtualItems = virtualizer.getVirtualItems()
  // The one row Tab lands on: the cursor's, while it is mounted; otherwise the
  // first row on screen, so Tab into a list the user scrolled still lands on
  // something they can see.
  const cursorMounted =
    focusedIndex >= 0 && virtualItems.some((item) => item.index === focusedIndex)
  const tabStopIndex = cursorMounted ? focusedIndex : (virtualItems[0]?.index ?? 0)

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto min-h-0">
      <div
        ref={containerRef}
        role="listbox"
        aria-label={t("panel.logListLabel")}
        data-log-list="true"
        className="outline-none relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((virtualRow) => {
          const log = filteredLogs[virtualRow.index]
          return (
            <div
              key={log.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <MemoizedLogEntry
                log={log}
                isExpanded={expandedIds.has(log.id)}
                onToggle={toggleExpanded}
                onSelect={handleSelectLog}
                onFocusTrace={handleFocusTrace}
                onFocusSession={handleFocusSession}
                searchQuery={searchQuery}
                useRegex={useRegex}
                isBookmarked={bookmarkedIds.has(log.id)}
                onToggleBookmark={toggleBookmark}
                isSelected={log.id === selectedLogId}
                index={virtualRow.index}
                onActivate={onActivateRow}
                isFocused={virtualRow.index === focusedIndex}
                isTabStop={virtualRow.index === tabStopIndex}
                onFocusRow={onFocusRow}
                setSize={filteredLogs.length}
                density={density}
                t={t}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface ErrorStateProps {
  scrollRef: React.RefObject<HTMLDivElement | null>
  error: Error
  onRetry?: () => void
  title: string
  retryLabel: string
  detailsLabel: string
}

function ErrorState({
  scrollRef,
  error,
  onRetry,
  title,
  retryLabel,
  detailsLabel,
}: ErrorStateProps) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  return (
    <div
      className="flex-1 overflow-auto min-h-0"
      ref={scrollRef}
      data-testid="log-virtualized-list-error"
    >
      <Alert variant="destructive" className="m-4">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          <div className="flex flex-col gap-3">
            <div className="font-medium">{title}</div>
            <div className="flex flex-wrap items-center gap-2">
              {onRetry && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRetry}
                  data-testid="log-virtualized-list-error-retry"
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  {retryLabel}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDetailsOpen((value) => !value)}
                data-testid="log-virtualized-list-error-details-toggle"
                aria-expanded={detailsOpen}
              >
                {detailsOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 mr-1.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 mr-1.5" />
                )}
                {detailsLabel}
              </Button>
            </div>
            {detailsOpen && (
              <pre
                data-testid="log-virtualized-list-error-details"
                className={cn(
                  "text-[10px] font-mono whitespace-pre-wrap break-words",
                  "rounded border border-destructive/30 bg-destructive/5 p-2 max-h-40 overflow-auto"
                )}
              >
                {error.message || String(error)}
              </pre>
            )}
          </div>
        </AlertDescription>
      </Alert>
    </div>
  )
}

export default VirtualizedLogList
