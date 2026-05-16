"use client"

/**
 * VirtualizedLogList
 *
 * Extracted from log-panel.tsx — virtualized log list with @tanstack/react-virtual.
 */

import React, { useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useTranslations } from "next-intl"
import { AlertCircle, ChevronDown, ChevronRight, Layers, RefreshCw } from "lucide-react"
import { Empty, EmptyTitle } from "@/components/ui/empty"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { MemoizedLogEntry, TraceGroup } from "./log-entry"
import type { StructuredLogEntry } from "@/lib/logger"

export const ESTIMATED_LOG_HEIGHT = 44
const SKELETON_ROW_COUNT = 8

export interface VirtualizedLogListEmptyContext {
  activeFilterLabels: string[]
  onClearFilters?: () => void
  onOpenPresets?: () => void
}

export interface VirtualizedLogListProps {
  scrollRef: React.RefObject<HTMLDivElement | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  isLoading: boolean
  error: Error | null
  filteredLogs: StructuredLogEntry[]
  groupByTraceId: boolean
  groupedLogs: Map<string, StructuredLogEntry[]>
  expandedIds: Set<string>
  toggleExpanded: (id: string) => void
  searchQuery: string
  useRegex: boolean
  bookmarkedIds: Set<string>
  toggleBookmark: (id: string) => void
  handleSelectLog: (log: StructuredLogEntry) => void
  handleFocusTrace: (traceId: string, log: StructuredLogEntry) => void
  handleFocusSession: (sessionId: string, log: StructuredLogEntry) => void
  t: ReturnType<typeof useTranslations>
  /** Retries the current query when the list fails to load. */
  onRetry?: () => void
  /** Describes the active filters so the empty state can reference them. */
  emptyStateContext?: VirtualizedLogListEmptyContext
}

export function VirtualizedLogList({
  scrollRef,
  containerRef,
  isLoading,
  error,
  filteredLogs,
  groupByTraceId,
  groupedLogs,
  expandedIds,
  toggleExpanded,
  searchQuery,
  useRegex,
  bookmarkedIds,
  toggleBookmark,
  handleSelectLog,
  handleFocusTrace,
  handleFocusSession,
  t,
  onRetry,
  emptyStateContext,
}: VirtualizedLogListProps) {
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_LOG_HEIGHT,
    overscan: 10,
  })

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
              style={{ height: ESTIMATED_LOG_HEIGHT }}
            >
              <div className="h-3 w-12 rounded bg-muted motion-safe:animate-pulse" />
              <div className="h-3 w-16 rounded bg-muted motion-safe:animate-pulse" />
              <div
                className="h-3 rounded bg-muted motion-safe:animate-pulse"
                style={{ width: `${40 + (index % 4) * 15}%` }}
              />
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
                      className="bg-muted/40 px-2 py-0.5 text-xs sm:text-[10px] font-mono"
                    >
                      {label}
                    </Badge>
                  ))}
                </div>
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

  if (groupByTraceId) {
    return (
      <div className="flex-1 overflow-auto min-h-0" ref={scrollRef}>
        <div className="p-2">
          {Array.from(groupedLogs.entries()).map(([traceId, traceLogs]) => (
            <TraceGroup
              key={traceId}
              traceId={traceId}
              logs={traceLogs}
              expandedIds={expandedIds}
              toggleExpanded={toggleExpanded}
              onFocusTrace={handleFocusTrace}
              onFocusSession={handleFocusSession}
              searchQuery={searchQuery}
              useRegex={useRegex}
              bookmarkedIds={bookmarkedIds}
              onToggleBookmark={toggleBookmark}
              t={t}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto min-h-0">
      <div
        ref={containerRef}
        tabIndex={0}
        className="outline-none relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
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
