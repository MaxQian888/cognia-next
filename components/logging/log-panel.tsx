"use client"

/**
 * LogPanel
 *
 * A comprehensive log viewing component that aggregates logs from multiple sources
 * (frontend, Tauri, MCP, plugins) with filtering, grouping, and export capabilities.
 *
 * Composed from extracted sub-components:
 * - LogPanelToolbar — view mode, search, filters, actions
 * - LogPanelStatsBar — stats summary, transport health
 * - VirtualizedLogList — virtualized log list
 * - LogDetailPanel — log detail view
 * - LogStatsDashboard — analytics dashboard
 * - LogTimeline — density timeline
 */

import { useRef, useState, useEffect, useCallback, useMemo, useDeferredValue } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyTitle } from "@/components/ui/empty"
import {
  useLogStream,
  useLogModules,
  useAgentTraceAsLogs,
  useTransportHealth,
} from "@/hooks/logging"
import { useLogPanelFilters, type PanelSource } from "@/hooks/logging/use-log-panel-filters"
import { LogPanelToolbar, type ExportFormat } from "./log-panel-toolbar"
import { LogPanelStatsBar, TransportHealthDetail, NativeLoggingDetail } from "./log-panel-stats-bar"
import { VirtualizedLogList } from "./log-virtualized-list"
import { LogStatsDashboard } from "./log-stats-dashboard"
import { LogTimeline } from "./log-timeline"
import { LogDetailPanel } from "./log-detail-panel"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { useMediaQuery } from "@/hooks/ui"
import { AGENT_TRACE_MODULE } from "@/lib/agent-trace/log-adapter"
import type { StructuredLogEntry } from "@/lib/logger"

// Time range options in milliseconds
const TIME_RANGES = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  all: 0,
} as const

const ALL_PANEL_SOURCES: PanelSource[] = ["frontend", "tauri", "mcp", "plugin", "internal"]
const LOG_PAGE_SIZE_OPTIONS = [25, 50, 100] as const

export interface LogPanelProps {
  className?: string
  maxHeight?: string
  defaultAutoRefresh?: boolean
  refreshInterval?: number
  groupByTraceId?: boolean
  showStats?: boolean
  showTimeline?: boolean
  sources?: ("frontend" | "tauri" | "mcp" | "plugin")[]
  includeAgentTrace?: boolean
}

function getLogSource(log: StructuredLogEntry): PanelSource {
  if (log.origin === "tauri" || log.runtime === "tauri") return "tauri"
  if (log.origin === "mcp" || log.runtime === "mcp") return "mcp"
  if (log.origin === "plugin" || log.runtime === "plugin") return "plugin"
  if (
    log.origin === "diagnostic" ||
    log.module === "logger.internal" ||
    (typeof log.data?.sourceTransport === "string" && log.data.sourceTransport.length > 0)
  )
    return "internal"
  return "frontend"
}

export function LogPanel({
  className,
  maxHeight,
  defaultAutoRefresh = false,
  refreshInterval = 2000,
  groupByTraceId = false,
  showStats = true,
  showTimeline = true,
  sources,
  includeAgentTrace = true,
}: LogPanelProps) {
  const t = useTranslations("logging")
  const filters = useLogPanelFilters({ defaultAutoRefresh, sources })
  // Above `lg` (1024px) use the side panel; below it, fall back to the bottom sheet.
  const isDesktopViewport = useMediaQuery("(min-width: 1024px)")
  const deferredSearchQuery = useDeferredValue(filters.searchQuery)
  const [customTimeRange, setCustomTimeRange] = useState<{ start: Date; end: Date } | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(50)

  const allowedSources = useMemo<PanelSource[]>(
    () =>
      sources && sources.length > 0
        ? Array.from(new Set([...sources, "internal"]))
        : ALL_PANEL_SOURCES,
    [sources]
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const modules = useLogModules()

  const { healthByTransport, queueDepthHistoryByTransport, nativeLogging } = useTransportHealth({
    autoRefresh: true,
    refreshInterval: Math.max(refreshInterval, 1500),
  })

  const selectedTransportHealth = filters.selectedTransportHealthName
    ? (healthByTransport[filters.selectedTransportHealthName] ?? null)
    : null
  const selectedTransportHistory = selectedTransportHealth
    ? ((queueDepthHistoryByTransport ?? {})[selectedTransportHealth.transport] ?? [])
    : []

  const effectiveSourceFilter =
    filters.sourceFilter !== "all" && !allowedSources.includes(filters.sourceFilter)
      ? "all"
      : filters.sourceFilter

  // Data hooks
  const { logs, groupedLogs, isLoading, error, refresh, clearLogs, stats, logRate } = useLogStream({
    autoRefresh: filters.autoRefresh,
    refreshInterval,
    level: filters.levelFilter,
    module:
      filters.moduleFilter === "all" || filters.moduleFilter === AGENT_TRACE_MODULE
        ? undefined
        : filters.moduleFilter,
    traceId: filters.traceFocusId || undefined,
    searchQuery: deferredSearchQuery || undefined,
    useRegex: filters.useRegex,
    groupByTraceId,
    maxLogs: 1000,
  })

  const agentTraceLogs = useAgentTraceAsLogs({ enabled: includeAgentTrace, maxLogs: 200 })

  // Merged and filtered logs
  const mergedLogs = useMemo(() => {
    if (!includeAgentTrace || agentTraceLogs.logs.length === 0) return logs
    return [...logs, ...agentTraceLogs.logs]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 1000)
  }, [logs, agentTraceLogs.logs, includeAgentTrace])

  const augmentedModules = useMemo(() => {
    if (!includeAgentTrace) return modules
    return modules.includes(AGENT_TRACE_MODULE) ? modules : [...modules, AGENT_TRACE_MODULE]
  }, [modules, includeAgentTrace])

  const getTimeRangeCutoff = useCallback(() => {
    if (filters.timeRange === "all") return 0
    return Date.now() - TIME_RANGES[filters.timeRange]
  }, [filters.timeRange])

  const filteredLogs = useMemo(() => {
    let result = mergedLogs.filter((log) => allowedSources.includes(getLogSource(log)))

    if (filters.moduleFilter === AGENT_TRACE_MODULE) {
      result = result.filter((log) => log.module === AGENT_TRACE_MODULE)
    } else if (filters.moduleFilter !== "all") {
      result = result.filter((log) => log.module !== AGENT_TRACE_MODULE)
    }

    if (effectiveSourceFilter !== "all") {
      result = result.filter((log) => getLogSource(log) === effectiveSourceFilter)
    }

    if (customTimeRange) {
      const startMs = customTimeRange.start.getTime()
      const endMs = customTimeRange.end.getTime()
      result = result.filter((log) => {
        const ts = new Date(log.timestamp).getTime()
        return ts >= startMs && ts <= endMs
      })
    } else if (filters.timeRange !== "all") {
      const cutoff = getTimeRangeCutoff()
      result = result.filter((log) => new Date(log.timestamp).getTime() >= cutoff)
    }

    if (filters.highSeverityOnly) {
      result = result.filter((log) => log.level === "error" || log.level === "fatal")
    }

    if (filters.traceFocusId) {
      result = result.filter((log) => log.traceId === filters.traceFocusId)
    }

    if (filters.sessionFilter.trim()) {
      result = result.filter((log) => log.sessionId === filters.sessionFilter.trim())
    }

    if (filters.diagnosticTransportFilter) {
      result = result.filter(
        (log) =>
          log.module === "logger.internal" &&
          String(log.data?.sourceTransport || "") === filters.diagnosticTransportFilter
      )
    }

    if (filters.bookmarkFilterActive) {
      result = result.filter((log) => filters.bookmarkedIds.has(log.id))
    }

    return result
  }, [
    mergedLogs,
    allowedSources,
    effectiveSourceFilter,
    filters.timeRange,
    getTimeRangeCutoff,
    filters.moduleFilter,
    filters.highSeverityOnly,
    filters.traceFocusId,
    filters.sessionFilter,
    filters.diagnosticTransportFilter,
    filters.bookmarkFilterActive,
    filters.bookmarkedIds,
    customTimeRange,
  ])

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize))
  const safeCurrentPage = Math.min(currentPage, totalPages)
  const paginatedLogs = useMemo(() => {
    const startIndex = (safeCurrentPage - 1) * pageSize
    return filteredLogs.slice(startIndex, startIndex + pageSize)
  }, [filteredLogs, pageSize, safeCurrentPage])

  const displayedGroupedLogs = useMemo(() => {
    if (!groupByTraceId) return groupedLogs

    const nextGroups = new Map<string, StructuredLogEntry[]>()
    for (const log of paginatedLogs) {
      const traceKey = log.traceId ?? "no-trace"
      const existingGroup = nextGroups.get(traceKey)
      if (existingGroup) {
        existingGroup.push(log)
      } else {
        nextGroups.set(traceKey, [log])
      }
    }
    return nextGroups
  }, [groupByTraceId, groupedLogs, paginatedLogs])

  useEffect(() => {
    filters.setFocusedIndex((prev) => {
      if (prev < 0 || paginatedLogs.length === 0) return -1
      return Math.min(prev, paginatedLogs.length - 1)
    })
  }, [filters, paginatedLogs.length])

  // Export
  const incidentExportBundle = useMemo(
    () => ({
      exportedAt: new Date().toISOString(),
      filters: {
        levelFilter: filters.levelFilter,
        moduleFilter: filters.moduleFilter,
        sourceFilter: effectiveSourceFilter,
        sessionFilter: filters.sessionFilter.trim() || null,
        timeRange: filters.timeRange,
        searchQuery: filters.searchQuery,
        useRegex: filters.useRegex,
        highSeverityOnly: filters.highSeverityOnly,
        traceFocusId: filters.traceFocusId,
        diagnosticTransportFilter: filters.diagnosticTransportFilter,
        allowedSources,
      },
      transportHealth: healthByTransport,
      nativeLogging,
      logs: filteredLogs,
    }),
    [filters, effectiveSourceFilter, allowedSources, healthByTransport, nativeLogging, filteredLogs]
  )

  const downloadBlob = useCallback((blob: Blob, extension: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `cognia-logs-${new Date().toISOString().split("T")[0]}.${extension}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [])

  const createExportBlob = useCallback((content: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType })
    // Polyfill blob.text() for test environments that lack it
    if (typeof (blob as Blob & { text?: () => Promise<string> }).text !== "function") {
      Object.defineProperty(blob, "text", {
        value: async () => content,
      })
    }
    return blob
  }, [])

  const handleExport = useCallback(
    (format: ExportFormat = "json") => {
      if (format === "json") {
        downloadBlob(
          createExportBlob(JSON.stringify(incidentExportBundle, null, 2), "application/json"),
          "json"
        )
        return
      }
      if (format === "csv") {
        const csvHeader = '"Timestamp","Level","Module","Message"\n'
        const csvContent = filteredLogs
          .map(
            (log) =>
              `"${new Date(log.timestamp).toISOString()}","${log.level}","${log.module}","${log.message.replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`
          )
          .join("\n")
        downloadBlob(createExportBlob(csvHeader + csvContent, "text/csv"), "csv")
        return
      }
      const content = [
        "# Cognia Incident Export",
        `# Filters: ${JSON.stringify(incidentExportBundle.filters)}`,
        `# TransportHealth: ${JSON.stringify(incidentExportBundle.transportHealth)}`,
        "",
        filteredLogs
          .map((log) => {
            const level = log.level.toUpperCase().padEnd(5)
            const moduleName = log.module.padEnd(15)
            const trace = log.traceId ? `[${log.traceId.slice(0, 8)}]` : ""
            return `${new Date(log.timestamp).toISOString()} ${level} ${moduleName} ${trace} ${log.message}`
          })
          .join("\n"),
      ].join("\n")
      downloadBlob(createExportBlob(content, "text/plain"), "txt")
    },
    [incidentExportBundle, filteredLogs, createExportBlob, downloadBlob]
  )

  const relatedLogs = useMemo(() => {
    if (!filters.selectedLog?.traceId) return []
    return logs.filter((l) => l.traceId === filters.selectedLog!.traceId)
  }, [logs, filters.selectedLog])

  const resetPagination = useCallback(() => {
    setCurrentPage(1)
    filters.setFocusedIndex(-1)
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [filters])

  const handlePageChange = useCallback(
    (page: number) => {
      const nextPage = Math.max(1, Math.min(page, totalPages))
      setCurrentPage(nextPage)
      filters.setFocusedIndex(-1)
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0
      }
    },
    [filters, totalPages]
  )

  const handlePageSizeChange = useCallback(
    (nextPageSize: number) => {
      setPageSize(nextPageSize)
      resetPagination()
    },
    [resetPagination]
  )

  const handleSearchQueryChange = useCallback(
    (value: string) => {
      resetPagination()
      filters.setSearchQuery(value)
    },
    [filters, resetPagination]
  )

  const handleUseRegexChange = useCallback(
    (value: boolean) => {
      resetPagination()
      filters.setUseRegex(value)
    },
    [filters, resetPagination]
  )

  const handleLevelFilterChange = useCallback(
    (value: typeof filters.levelFilter) => {
      resetPagination()
      filters.setLevelFilter(value)
    },
    [filters, resetPagination]
  )

  const handleModuleFilterChange = useCallback(
    (value: string) => {
      resetPagination()
      filters.setModuleFilter(value)
    },
    [filters, resetPagination]
  )

  const handleSourceFilterChange = useCallback(
    (value: PanelSource | "all") => {
      resetPagination()
      filters.setSourceFilter(value)
    },
    [filters, resetPagination]
  )

  const handleSessionFilterChange = useCallback(
    (value: string) => {
      resetPagination()
      filters.setSessionFilter(value)
    },
    [filters, resetPagination]
  )

  const handleTimeRangeChange = useCallback(
    (value: typeof filters.timeRange) => {
      resetPagination()
      filters.setTimeRange(value)
    },
    [filters, resetPagination]
  )

  // Active filter labels for the empty-state — referenced by VirtualizedLogList.
  const emptyStateActiveFilterLabels = useMemo(() => {
    const labels: string[] = []
    if (filters.levelFilter !== "all") labels.push(`level=${filters.levelFilter}`)
    if (filters.moduleFilter !== "all") labels.push(`module=${filters.moduleFilter}`)
    if (filters.sourceFilter !== "all") labels.push(`source=${filters.sourceFilter}`)
    if (filters.sessionFilter.trim()) labels.push(`session=${filters.sessionFilter.trim()}`)
    if (filters.timeRange !== "all") labels.push(`time=${filters.timeRange}`)
    if (filters.searchQuery.trim()) labels.push(`search=${filters.searchQuery.trim()}`)
    if (filters.traceFocusId) labels.push("trace-focus")
    if (filters.diagnosticTransportFilter)
      labels.push(`transport=${filters.diagnosticTransportFilter}`)
    if (filters.bookmarkFilterActive) labels.push("bookmarks")
    return labels
  }, [
    filters.levelFilter,
    filters.moduleFilter,
    filters.sourceFilter,
    filters.sessionFilter,
    filters.timeRange,
    filters.searchQuery,
    filters.traceFocusId,
    filters.diagnosticTransportFilter,
    filters.bookmarkFilterActive,
  ])

  const handleClearAllFilters = useCallback(() => {
    resetPagination()
    filters.setLevelFilter("all")
    filters.setModuleFilter("all")
    filters.setSourceFilter("all")
    filters.setSessionFilter("")
    filters.setTimeRange("all")
    filters.setSearchQuery("")
    filters.setTraceFocusId(null)
    filters.setDiagnosticTransportFilter(null)
    filters.setBookmarkFilterActive(false)
  }, [filters, resetPagination])

  const handleTraceFocusChange = useCallback(
    (value: string | null) => {
      resetPagination()
      filters.setTraceFocusId(value)
    },
    [filters, resetPagination]
  )

  const handleHighSeverityOnlyChange = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      resetPagination()
      filters.setHighSeverityOnly(value)
    },
    [filters, resetPagination]
  )

  const handlePresetChange = useCallback(
    (presetId: string) => {
      resetPagination()
      filters.handlePresetChange(presetId)
    },
    [filters, resetPagination]
  )

  const handleFocusTrace = useCallback(
    (traceId: string, log: StructuredLogEntry) => {
      resetPagination()
      filters.handleFocusTrace(traceId, log)
    },
    [filters, resetPagination]
  )

  const handleFocusSession = useCallback(
    (sessionId: string, log: StructuredLogEntry) => {
      resetPagination()
      filters.handleFocusSession(sessionId, log)
    },
    [filters, resetPagination]
  )

  const handleDiagnosticTransportFilterChange = useCallback(
    (value: string | null) => {
      resetPagination()
      filters.setDiagnosticTransportFilter(value)
    },
    [filters, resetPagination]
  )

  const handleCustomTimeRangeChange = useCallback(
    (range: { start: Date; end: Date } | null) => {
      resetPagination()
      setCustomTimeRange(range)
    },
    [resetPagination]
  )

  // Scroll controls
  const scrollToTop = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [])
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (e.key === "r" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        refresh()
      } else if (e.key === "Escape") {
        if (filters.showDetailPanel) filters.setShowDetailPanel(false)
        else handleSearchQueryChange("")
      } else if (e.key === "d" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        filters.setViewMode((prev) => (prev === "list" ? "dashboard" : "list"))
      } else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault()
        filters.setFocusedIndex((prev) => Math.min(prev + 1, paginatedLogs.length - 1))
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault()
        filters.setFocusedIndex((prev) => Math.max(prev - 1, 0))
      } else if (
        e.key === "Enter" &&
        filters.focusedIndex >= 0 &&
        filters.focusedIndex < paginatedLogs.length
      ) {
        e.preventDefault()
        filters.toggleExpanded(paginatedLogs[filters.focusedIndex].id)
      } else if (
        e.key === "o" &&
        filters.focusedIndex >= 0 &&
        filters.focusedIndex < paginatedLogs.length
      ) {
        e.preventDefault()
        filters.handleSelectLog(paginatedLogs[filters.focusedIndex])
      } else if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        filters.setShowShortcutsDialog(true)
      }
    }

    const container = containerRef.current
    if (container) {
      container.addEventListener("keydown", handleKeyDown)
      return () => container.removeEventListener("keydown", handleKeyDown)
    }
  }, [refresh, filters, handleSearchQueryChange, paginatedLogs])

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (scrollRef.current && safeCurrentPage === 1 && filters.autoScroll && filters.autoRefresh) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs.length, safeCurrentPage, filters.autoScroll, filters.autoRefresh])

  return (
    <div
      className={cn("flex flex-col border rounded-lg bg-background h-full", className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {/* Toolbar */}
      <LogPanelToolbar
        viewMode={filters.viewMode}
        setViewMode={filters.setViewMode}
        includeAgentTrace={includeAgentTrace}
        searchQuery={filters.searchQuery}
        setSearchQuery={handleSearchQueryChange}
        useRegex={filters.useRegex}
        setUseRegex={handleUseRegexChange}
        levelFilter={filters.levelFilter}
        setLevelFilter={handleLevelFilterChange}
        moduleFilter={filters.moduleFilter}
        setModuleFilter={handleModuleFilterChange}
        augmentedModules={augmentedModules}
        sourceFilter={effectiveSourceFilter}
        setSourceFilter={handleSourceFilterChange}
        allowedSources={allowedSources}
        sessionFilter={filters.sessionFilter}
        setSessionFilter={handleSessionFilterChange}
        timeRange={filters.timeRange}
        setTimeRange={handleTimeRangeChange}
        stats={stats}
        presets={filters.presets}
        activePresetId={filters.activePresetId}
        handlePresetChange={handlePresetChange}
        saveCurrentPreset={filters.saveCurrentPreset}
        removeActivePreset={filters.removeActivePreset}
        EMPTY_PRESET_VALUE={filters.EMPTY_PRESET_VALUE}
        highSeverityOnly={filters.highSeverityOnly}
        setHighSeverityOnly={handleHighSeverityOnlyChange}
        traceFocusId={filters.traceFocusId}
        setTraceFocusId={handleTraceFocusChange}
        autoRefresh={filters.autoRefresh}
        setAutoRefresh={filters.setAutoRefresh}
        refresh={refresh}
        onExport={handleExport}
        clearLogs={clearLogs}
        showDetailPanel={filters.showDetailPanel}
        setShowDetailPanel={filters.setShowDetailPanel}
        autoScroll={filters.autoScroll}
        setAutoScroll={filters.setAutoScroll}
        scrollToTop={scrollToTop}
        scrollToBottom={scrollToBottom}
        clearSessionFocus={() => handleSessionFilterChange("")}
        hasSessionFocus={!!filters.sessionFilter.trim()}
        bookmarkFilterActive={filters.bookmarkFilterActive}
        setBookmarkFilterActive={filters.setBookmarkFilterActive}
        bookmarkedCount={filters.bookmarkedIds.size}
        showAdvancedFilters={filters.showAdvancedFilters}
        setShowAdvancedFilters={filters.setShowAdvancedFilters}
        showShortcutsDialog={filters.showShortcutsDialog}
        setShowShortcutsDialog={filters.setShowShortcutsDialog}
        searchHistory={filters.searchHistory}
        addSearchHistory={filters.addSearchHistory}
        removeSearchHistoryItem={filters.removeSearchHistoryItem}
        clearSearchHistory={filters.clearSearchHistory}
        diagnosticTransportFilter={filters.diagnosticTransportFilter}
        setDiagnosticTransportFilter={handleDiagnosticTransportFilterChange}
      />

      {/* Stats bar */}
      {showStats && (
        <LogPanelStatsBar
          filteredCount={filteredLogs.length}
          totalCount={stats.total}
          stats={stats}
          logRate={logRate}
          autoRefresh={filters.autoRefresh}
          healthByTransport={healthByTransport}
          nativeLogging={nativeLogging}
          onTransportClick={filters.setSelectedTransportHealthName}
          onNativeLoggingClick={() => filters.setSelectedNativeLogging(true)}
          currentPage={safeCurrentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          pageSizeOptions={LOG_PAGE_SIZE_OPTIONS}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
        />
      )}

      {/* Transport health detail */}
      {selectedTransportHealth && (
        <TransportHealthDetail
          health={selectedTransportHealth}
          history={selectedTransportHistory}
          onClose={() => {
            filters.setSelectedTransportHealthName(null)
            handleDiagnosticTransportFilterChange(null)
          }}
          onViewDiagnostics={() => {
            handleDiagnosticTransportFilterChange(selectedTransportHealth.transport)
            handleSourceFilterChange("internal")
          }}
        />
      )}

      {/* Native logging detail */}
      {filters.selectedNativeLogging && (
        <NativeLoggingDetail
          nativeLogging={nativeLogging}
          onClose={() => filters.setSelectedNativeLogging(false)}
          onViewDiagnostics={() => {
            resetPagination()
            filters.setSourceFilter("tauri")
            filters.setSearchQuery("native_logging")
            filters.setDiagnosticTransportFilter(null)
          }}
        />
      )}

      {/* Main content area with optional detail panel */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          {showTimeline && filters.viewMode === "list" && filteredLogs.length > 0 && (
            <LogTimeline
              logs={filteredLogs}
              selectedRange={customTimeRange}
              onTimeRangeClick={(start, end) => {
                // If clearing (start is epoch 0), remove custom filter
                if (start.getTime() === 0) {
                  handleCustomTimeRangeChange(null)
                } else {
                  handleCustomTimeRangeChange({ start, end })
                }
              }}
            />
          )}

          {filters.viewMode === "dashboard" ? (
            <ScrollArea className="flex-1">
              <LogStatsDashboard
                logs={filteredLogs}
                logRate={logRate}
                nativeLogging={nativeLogging}
                onSearchFilter={handleSearchQueryChange}
              />
            </ScrollArea>
          ) : filters.viewMode === "trace" ? (
            <ScrollArea className="flex-1">
              <Empty className="py-12">
                <EmptyTitle>{t("panel.noTraceEvents")}</EmptyTitle>
              </Empty>
            </ScrollArea>
          ) : (
            <VirtualizedLogList
              scrollRef={scrollRef}
              containerRef={containerRef}
              isLoading={isLoading}
              error={error}
              filteredLogs={paginatedLogs}
              groupByTraceId={groupByTraceId}
              groupedLogs={displayedGroupedLogs}
              expandedIds={filters.expandedIds}
              toggleExpanded={filters.toggleExpanded}
              searchQuery={filters.searchQuery}
              useRegex={filters.useRegex}
              bookmarkedIds={filters.bookmarkedIds}
              toggleBookmark={filters.toggleBookmark}
              handleSelectLog={filters.handleSelectLog}
              handleFocusTrace={handleFocusTrace}
              handleFocusSession={handleFocusSession}
              t={t}
              onRetry={refresh}
              emptyStateContext={{
                activeFilterLabels: emptyStateActiveFilterLabels,
                onClearFilters:
                  emptyStateActiveFilterLabels.length > 0 ? handleClearAllFilters : undefined,
                onOpenPresets:
                  filters.presets.length > 0
                    ? () => filters.setShowAdvancedFilters(true)
                    : undefined,
              }}
            />
          )}
        </div>

        {filters.showDetailPanel && filters.selectedLog && isDesktopViewport && (
          <LogDetailPanel
            log={filters.selectedLog}
            relatedLogs={relatedLogs}
            isBookmarked={filters.bookmarkedIds.has(filters.selectedLog.id)}
            onClose={() => filters.setShowDetailPanel(false)}
            onToggleBookmark={filters.toggleBookmark}
            onSelectRelated={(log) => filters.setSelectedLog(log)}
            className="w-[350px] lg:w-[400px] shrink-0"
          />
        )}

        {/* Responsive sheet for narrow viewports */}
        {!isDesktopViewport && (
          <Sheet
            open={filters.showDetailPanel && Boolean(filters.selectedLog)}
            onOpenChange={(open) => {
              if (!open) filters.setShowDetailPanel(false)
            }}
          >
            <SheetContent
              side="bottom"
              className="h-[80vh] p-0 flex flex-col"
              data-testid="log-detail-sheet"
            >
              <SheetHeader className="sr-only">
                <SheetTitle>{t("panel.logDetails")}</SheetTitle>
                <SheetDescription>{t("panel.logDetails")}</SheetDescription>
              </SheetHeader>
              {filters.selectedLog && (
                <LogDetailPanel
                  log={filters.selectedLog}
                  relatedLogs={relatedLogs}
                  isBookmarked={filters.bookmarkedIds.has(filters.selectedLog.id)}
                  onClose={() => filters.setShowDetailPanel(false)}
                  onToggleBookmark={filters.toggleBookmark}
                  onSelectRelated={(log) => filters.setSelectedLog(log)}
                  className="flex-1 border-0"
                />
              )}
            </SheetContent>
          </Sheet>
        )}
      </div>
    </div>
  )
}

export default LogPanel
