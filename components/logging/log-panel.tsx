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

import {
  type ReactNode,
  createContext,
  useContext,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useDeferredValue,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import {
  useLogStream,
  useLogModules,
  useAgentTraceAsLogs,
  useTransportHealth,
} from "@/hooks/logging"
import {
  useLogPanelFilters,
  type LogPanelFilterState,
  type PanelSource,
} from "@/hooks/logging/use-log-panel-filters"
import { useLogPanelUrlSync } from "@/hooks/logging/use-log-panel-url-sync"
import { LogPanelToolbar, type ExportFormat } from "./log-panel-toolbar"
import { AgentTraceStatsBar } from "./agent-trace-stats-bar"
import { LogPanelStatsBar, TransportHealthDetail, NativeLoggingDetail } from "./log-panel-stats-bar"
import { VirtualizedLogList } from "./log-virtualized-list"
import { LogStatsDashboard } from "./log-stats-dashboard"
import { LogTimeline } from "./log-timeline"
import { LogTraceView } from "./log-trace-view"
import { LogDetailPanel } from "./log-detail-panel"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { useMediaQuery, useResizableLayout, type UseResizableLayoutResult } from "@/hooks/ui"
import { AGENT_TRACE_MODULE } from "@cognia/agent-trace/log-adapter"
import type { LogFilterPreset } from "@/types/logging"
import type { StructuredLogEntry } from "@/lib/logging"

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
const NEW_LOG_TOAST_THROTTLE_MS = 5000

export interface LogPanelHeaderApi {
  totalCount: number
  filteredCount: number
  activePresetId: string
  presets: LogFilterPreset[]
  handlePresetChange: (id: string) => void
  onOpenShortcuts: () => void
  EMPTY_PRESET_VALUE: string
}

const LogPanelHeaderContext = createContext<LogPanelHeaderApi | null>(null)

/**
 * Read the LogPanel's header API from inside a component supplied as
 * `headerSlot`. Throws when used outside the panel — that signals the host
 * forgot to nest the consumer under `<LogPanel headerSlot={...} />`.
 */
export function useLogPanelHeader(): LogPanelHeaderApi {
  const ctx = useContext(LogPanelHeaderContext)
  if (!ctx) {
    throw new Error("useLogPanelHeader must be used inside a LogPanel headerSlot")
  }
  return ctx
}

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
  /**
   * Optional header content rendered above the toolbar. The host page may
   * read panel state via `useLogPanelHeader()`, which surfaces totals,
   * presets, and a few light callbacks without forking the filter machine.
   */
  headerSlot?: ReactNode
  /**
   * When `true`, the inner toolbar's preset dropdown is hidden so the host
   * page can own preset selection from `headerSlot`. Defaults to `false`.
   */
  hideToolbarPresets?: boolean
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
  headerSlot,
  hideToolbarPresets = false,
}: LogPanelProps) {
  const t = useTranslations("logging")
  const filters = useLogPanelFilters({ defaultAutoRefresh, sources })
  useLogPanelUrlSync(filters)
  // Destructure the identity-stable setters once. Handlers below depend on
  // these instead of the whole `filters` object — otherwise ANY of its ~30
  // state fields changing (selected log, expanded row, arrow-key focus, every
  // poll) would recreate every callback and defeat the toolbar/row memoization.
  const {
    setCurrentPage,
    setFocusedIndex,
    setSearchQuery,
    setUseRegex,
    setLevelFilter,
    setModuleFilter,
    setSourceFilter,
    setSessionFilter,
    setTimeRange,
    setTraceFocusId,
    setDiagnosticTransportFilter,
    setCustomTimeRange,
    setHighSeverityOnly,
    setBookmarkFilterActive,
    setShowShortcutsDialog,
    setPageSize,
    setSelectedLog,
  } = filters
  // Above `lg` (1024px) use the side panel; below it, fall back to the bottom sheet.
  const isDesktopViewport = useMediaQuery("(min-width: 1024px)")
  const deferredSearchQuery = useDeferredValue(filters.searchQuery)
  // customTimeRange + currentPage + pageSize now live in useLogPanelFilters so
  // the URL-sync hook above has a single state container to mirror.
  const { customTimeRange, currentPage, pageSize } = filters

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

  // Merged and filtered logs.
  // Both inputs come from `useLogStream` / `useAgentTraceAsLogs`, which
  // produce timestamp-descending arrays. A linear two-pointer merge is O(n+m)
  // and avoids the per-poll O(n log n) sort + allocation of a doubled array.
  const mergedLogs = useMemo(() => {
    if (!includeAgentTrace || agentTraceLogs.logs.length === 0) return logs
    const a = logs
    const b = agentTraceLogs.logs
    const limit = Math.min(1000, a.length + b.length)
    const out: StructuredLogEntry[] = new Array(limit)
    let ai = 0
    let bi = 0
    for (let i = 0; i < limit; i++) {
      if (ai >= a.length) {
        out[i] = b[bi++]
      } else if (bi >= b.length) {
        out[i] = a[ai++]
      } else if (a[ai].timestamp >= b[bi].timestamp) {
        out[i] = a[ai++]
      } else {
        out[i] = b[bi++]
      }
    }
    return out
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
    // Hoist all filter inputs once so each predicate is a constant-time check.
    const moduleFilter = filters.moduleFilter
    const moduleIsAgentTrace = moduleFilter === AGENT_TRACE_MODULE
    const moduleIsSpecific = moduleFilter !== "all" && !moduleIsAgentTrace
    const customStartMs = customTimeRange?.start.getTime() ?? 0
    const customEndMs = customTimeRange?.end.getTime() ?? 0
    const hasCustomTimeRange = customTimeRange !== null
    const hasPresetTimeRange = !hasCustomTimeRange && filters.timeRange !== "all"
    const presetCutoff = hasPresetTimeRange ? getTimeRangeCutoff() : 0
    const highSeverityOnly = filters.highSeverityOnly
    const traceFocusId = filters.traceFocusId
    const sessionFilterTrimmed = filters.sessionFilter.trim()
    const hasSessionFilter = sessionFilterTrimmed.length > 0
    const diagnosticTransport = filters.diagnosticTransportFilter
    const bookmarkFilterActive = filters.bookmarkFilterActive
    const bookmarkedIds = filters.bookmarkedIds
    const allowedSourcesSet =
      allowedSources.length === ALL_PANEL_SOURCES.length
        ? null
        : new Set<PanelSource>(allowedSources)

    const result: StructuredLogEntry[] = []
    for (let i = 0; i < mergedLogs.length; i++) {
      const log = mergedLogs[i]

      // Single getLogSource() lookup per row (was previously computed twice).
      const source = getLogSource(log)
      if (allowedSourcesSet && !allowedSourcesSet.has(source)) continue
      if (effectiveSourceFilter !== "all" && source !== effectiveSourceFilter) continue

      const isAgentTrace = log.module === AGENT_TRACE_MODULE
      if (moduleIsAgentTrace) {
        if (!isAgentTrace) continue
      } else if (moduleIsSpecific && isAgentTrace) {
        continue
      }

      if (hasCustomTimeRange || hasPresetTimeRange) {
        const ts = new Date(log.timestamp).getTime()
        if (hasCustomTimeRange) {
          if (ts < customStartMs || ts > customEndMs) continue
        } else if (ts < presetCutoff) {
          continue
        }
      }

      if (highSeverityOnly && log.level !== "error" && log.level !== "fatal") continue
      if (traceFocusId && log.traceId !== traceFocusId) continue
      if (hasSessionFilter && log.sessionId !== sessionFilterTrimmed) continue
      if (diagnosticTransport) {
        if (log.module !== "logger.internal") continue
        if (String(log.data?.sourceTransport || "") !== diagnosticTransport) continue
      }
      if (bookmarkFilterActive && !bookmarkedIds.has(log.id)) continue

      result.push(log)
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
    setFocusedIndex((prev) => {
      if (prev < 0 || paginatedLogs.length === 0) return -1
      return Math.min(prev, paginatedLogs.length - 1)
    })
  }, [setFocusedIndex, paginatedLogs.length])

  // Export state lives in a ref so the bundle is built lazily on demand —
  // previously it was rebuilt (with a fresh Date) on every render/poll, and
  // its dependency on `filters` churned the export handler identity.
  const exportStateRef = useRef({
    filters,
    effectiveSourceFilter,
    allowedSources,
    healthByTransport,
    nativeLogging,
    filteredLogs,
  })
  useEffect(() => {
    exportStateRef.current = {
      filters,
      effectiveSourceFilter,
      allowedSources,
      healthByTransport,
      nativeLogging,
      filteredLogs,
    }
  })

  const buildExportBundle = useCallback(() => {
    const state = exportStateRef.current
    return {
      exportedAt: new Date().toISOString(),
      filters: {
        levelFilter: state.filters.levelFilter,
        moduleFilter: state.filters.moduleFilter,
        sourceFilter: state.effectiveSourceFilter,
        sessionFilter: state.filters.sessionFilter.trim() || null,
        timeRange: state.filters.timeRange,
        searchQuery: state.filters.searchQuery,
        useRegex: state.filters.useRegex,
        highSeverityOnly: state.filters.highSeverityOnly,
        traceFocusId: state.filters.traceFocusId,
        diagnosticTransportFilter: state.filters.diagnosticTransportFilter,
        allowedSources: state.allowedSources,
      },
      transportHealth: state.healthByTransport,
      nativeLogging: state.nativeLogging,
      logs: state.filteredLogs,
    }
  }, [])

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
      const bundle = buildExportBundle()
      if (format === "json") {
        downloadBlob(createExportBlob(JSON.stringify(bundle, null, 2), "application/json"), "json")
        return
      }
      if (format === "csv") {
        const csvHeader = '"Timestamp","Level","Module","Message"\n'
        const csvContent = bundle.logs
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
        `# Filters: ${JSON.stringify(bundle.filters)}`,
        `# TransportHealth: ${JSON.stringify(bundle.transportHealth)}`,
        "",
        bundle.logs
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
    [buildExportBundle, createExportBlob, downloadBlob]
  )

  const relatedLogs = useMemo(() => {
    if (!filters.selectedLog?.traceId) return []
    return logs.filter((l) => l.traceId === filters.selectedLog!.traceId)
  }, [logs, filters.selectedLog])

  const resetPagination = useCallback(() => {
    setCurrentPage(1)
    setFocusedIndex(-1)
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [setCurrentPage, setFocusedIndex])

  const handlePageChange = useCallback(
    (page: number) => {
      const nextPage = Math.max(1, Math.min(page, totalPages))
      setCurrentPage(nextPage)
      setFocusedIndex(-1)
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0
      }
    },
    [setCurrentPage, setFocusedIndex, totalPages]
  )

  const handlePageSizeChange = useCallback(
    (nextPageSize: number) => {
      setPageSize(nextPageSize)
      resetPagination()
    },
    [setPageSize, resetPagination]
  )

  const handleSearchQueryChange = useCallback(
    (value: string) => {
      resetPagination()
      setSearchQuery(value)
    },
    [setSearchQuery, resetPagination]
  )

  const handleUseRegexChange = useCallback(
    (value: boolean) => {
      resetPagination()
      setUseRegex(value)
    },
    [setUseRegex, resetPagination]
  )

  const handleLevelFilterChange = useCallback(
    (value: LogPanelFilterState["levelFilter"]) => {
      resetPagination()
      setLevelFilter(value)
    },
    [setLevelFilter, resetPagination]
  )

  const handleModuleFilterChange = useCallback(
    (value: string) => {
      resetPagination()
      setModuleFilter(value)
    },
    [setModuleFilter, resetPagination]
  )

  const handleSourceFilterChange = useCallback(
    (value: PanelSource | "all") => {
      resetPagination()
      setSourceFilter(value)
    },
    [setSourceFilter, resetPagination]
  )

  const handleSessionFilterChange = useCallback(
    (value: string) => {
      resetPagination()
      setSessionFilter(value)
    },
    [setSessionFilter, resetPagination]
  )

  // Stable wrapper so the toolbar's `clearSessionFocus` prop keeps its identity.
  const handleClearSessionFocus = useCallback(() => {
    handleSessionFilterChange("")
  }, [handleSessionFilterChange])

  const handleTimeRangeChange = useCallback(
    (value: LogPanelFilterState["timeRange"]) => {
      resetPagination()
      setTimeRange(value)
    },
    [setTimeRange, resetPagination]
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
    setLevelFilter("all")
    setModuleFilter("all")
    setSourceFilter("all")
    setSessionFilter("")
    setTimeRange("all")
    setSearchQuery("")
    setTraceFocusId(null)
    setDiagnosticTransportFilter(null)
    setBookmarkFilterActive(false)
  }, [
    resetPagination,
    setLevelFilter,
    setModuleFilter,
    setSourceFilter,
    setSessionFilter,
    setTimeRange,
    setSearchQuery,
    setTraceFocusId,
    setDiagnosticTransportFilter,
    setBookmarkFilterActive,
  ])

  const handleTraceFocusChange = useCallback(
    (value: string | null) => {
      resetPagination()
      setTraceFocusId(value)
    },
    [setTraceFocusId, resetPagination]
  )

  const handleHighSeverityOnlyChange = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      resetPagination()
      setHighSeverityOnly(value)
    },
    [setHighSeverityOnly, resetPagination]
  )

  const applyPresetById = filters.handlePresetChange
  const handlePresetChange = useCallback(
    (presetId: string) => {
      resetPagination()
      applyPresetById(presetId)
    },
    [applyPresetById, resetPagination]
  )

  const focusTrace = filters.handleFocusTrace
  const handleFocusTrace = useCallback(
    (traceId: string, log: StructuredLogEntry) => {
      resetPagination()
      focusTrace(traceId, log)
    },
    [focusTrace, resetPagination]
  )

  const focusSession = filters.handleFocusSession
  const handleFocusSession = useCallback(
    (sessionId: string, log: StructuredLogEntry) => {
      resetPagination()
      focusSession(sessionId, log)
    },
    [focusSession, resetPagination]
  )

  const handleDiagnosticTransportFilterChange = useCallback(
    (value: string | null) => {
      resetPagination()
      setDiagnosticTransportFilter(value)
    },
    [setDiagnosticTransportFilter, resetPagination]
  )

  const handleCustomTimeRangeChange = useCallback(
    (range: { start: Date; end: Date } | null) => {
      resetPagination()
      setCustomTimeRange(range)
    },
    [setCustomTimeRange, resetPagination]
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

  // Keyboard shortcuts — attached to `window` so the panel listens regardless
  // of where focus currently sits (previously bound to the virtualizer host
  // div, which silently broke shortcuts when focus was elsewhere). The effect
  // re-attaches whenever the captured values change; since the listener target
  // is `window`, attach/detach is O(1) and harmless during polling.
  useEffect(() => {
    if (typeof window === "undefined") return
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore shortcuts while the user is typing in any text input.
      const target = e.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return
      }
      // Ignore shortcuts while a modal dialog is open so its keyboard
      // semantics aren't shadowed (e.g. the shortcuts dialog itself).
      if (typeof document !== "undefined") {
        const openDialog = document.querySelector('div[role="dialog"][data-state="open"]')
        if (openDialog) return
      }

      if (e.key === "r" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        refresh()
      } else if (e.key === "Escape") {
        if (filters.showDetailPanel) filters.setShowDetailPanel(false)
        else handleSearchQueryChange("")
      } else if (e.key === "d" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        filters.setViewMode((prev) => (prev === "list" ? "dashboard" : "list"))
      } else if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        const searchInput = document.querySelector<HTMLInputElement>(
          '[data-testid="log-panel-toolbar"] input[role="combobox"]'
        )
        searchInput?.focus()
      } else if (e.key === "b" && !e.ctrlKey && !e.metaKey) {
        const focused = filters.focusedIndex
        if (focused >= 0 && focused < paginatedLogs.length) {
          e.preventDefault()
          filters.toggleBookmark(paginatedLogs[focused].id)
        }
      } else if (e.key === "g" && !e.ctrlKey && !e.metaKey) {
        if (filters.presets.length === 0) return
        e.preventDefault()
        filters.setShowAdvancedFilters(true)
        // Defer to next frame so the preset trigger has time to mount before
        // we click it open.
        requestAnimationFrame(() => {
          const trigger =
            document.querySelector<HTMLButtonElement>('[data-testid="log-panel-preset-trigger"]') ??
            document.querySelector<HTMLButtonElement>(
              '[data-testid="log-page-header-preset-trigger"]'
            )
          if (trigger) {
            trigger.focus()
            trigger.click()
          }
        })
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

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [filters, refresh, handleSearchQueryChange, paginatedLogs])

  // Auto-scroll / new-logs toast.
  //
  // When `autoRefresh` is on and the user is on the first page, scroll the
  // virtualizer to the latest entry as before. When the user is paged away
  // from the latest entries, surface a throttled Sonner toast with a
  // "Jump to latest" action instead — preserves their browsing position but
  // gives them a one-click way to come back. Without this branch the user
  // silently misses every new entry on pages > 1.
  const lastSeenLogCountRef = useRef(logs.length)
  const lastToastAtRef = useRef(0)
  useEffect(() => {
    const previous = lastSeenLogCountRef.current
    const delta = logs.length - previous
    lastSeenLogCountRef.current = logs.length

    if (!filters.autoRefresh || delta <= 0) return

    if (safeCurrentPage === 1) {
      if (scrollRef.current && filters.autoScroll) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      return
    }

    const now = Date.now()
    if (now - lastToastAtRef.current < NEW_LOG_TOAST_THROTTLE_MS) return
    lastToastAtRef.current = now

    toast(t("panel.newLogsToast", { count: delta }), {
      id: "log-panel-new-logs",
      action: {
        label: t("panel.jumpToLatest"),
        onClick: () => {
          setCurrentPage(1)
          requestAnimationFrame(() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight
            }
          })
        },
      },
    })
  }, [logs.length, safeCurrentPage, filters.autoRefresh, filters.autoScroll, setCurrentPage, t])

  const onOpenShortcuts = useCallback(() => {
    setShowShortcutsDialog(true)
  }, [setShowShortcutsDialog])

  // Detail-panel navigation — step the selection through the current page
  // without leaving the detail view.
  const selectedLogId = filters.selectedLog?.id ?? null
  const selectedIndex = useMemo(() => {
    if (!selectedLogId) return -1
    return paginatedLogs.findIndex((log) => log.id === selectedLogId)
  }, [paginatedLogs, selectedLogId])

  const handleNavigateDetail = useCallback(
    (delta: -1 | 1) => {
      if (selectedIndex < 0) return
      const next = paginatedLogs[selectedIndex + delta]
      if (next) setSelectedLog(next)
    },
    [paginatedLogs, selectedIndex, setSelectedLog]
  )

  const resizableLayout = useResizableLayout("cognia-logs-panel-split")
  const headerContextValue = useMemo<LogPanelHeaderApi>(
    () => ({
      totalCount: stats.total,
      filteredCount: filteredLogs.length,
      activePresetId: filters.activePresetId,
      presets: filters.presets,
      handlePresetChange,
      onOpenShortcuts,
      EMPTY_PRESET_VALUE: filters.EMPTY_PRESET_VALUE,
    }),
    [
      stats.total,
      filteredLogs.length,
      filters.activePresetId,
      filters.presets,
      handlePresetChange,
      onOpenShortcuts,
      filters.EMPTY_PRESET_VALUE,
    ]
  )

  return (
    <LogPanelHeaderContext.Provider value={headerContextValue}>
      <div
        className={cn("flex flex-col border rounded-lg bg-background h-full", className)}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {headerSlot}
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
          clearSessionFocus={handleClearSessionFocus}
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
          customTimeRange={customTimeRange}
          setCustomTimeRange={handleCustomTimeRangeChange}
          hideToolbarPresets={hideToolbarPresets}
          density={filters.density}
          setDensity={filters.setDensity}
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

        {/* Agent-trace stats — rendered whenever the user has scoped the
            panel to the `agent.trace` module, so the cost / token / cache /
            error headline numbers sit right above the trace list. */}
        {filters.moduleFilter === AGENT_TRACE_MODULE && (
          <AgentTraceStatsBar window="today" className="px-3 pt-2" />
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
        <MainContent
          showTimeline={showTimeline}
          viewMode={filters.viewMode}
          filteredLogs={filteredLogs}
          paginatedLogs={paginatedLogs}
          customTimeRange={customTimeRange}
          handleCustomTimeRangeChange={handleCustomTimeRangeChange}
          logRate={logRate}
          nativeLogging={nativeLogging}
          handleSearchQueryChange={handleSearchQueryChange}
          groupByTraceId={groupByTraceId}
          displayedGroupedLogs={displayedGroupedLogs}
          filters={filters}
          handleFocusTrace={handleFocusTrace}
          handleFocusSession={handleFocusSession}
          handleTraceFocusChange={handleTraceFocusChange}
          emptyStateActiveFilterLabels={emptyStateActiveFilterLabels}
          handleClearAllFilters={handleClearAllFilters}
          isLoading={isLoading}
          error={error}
          refresh={refresh}
          scrollRef={scrollRef}
          containerRef={containerRef}
          isDesktopViewport={isDesktopViewport}
          relatedLogs={relatedLogs}
          resizableLayout={resizableLayout}
          density={filters.density}
          selectedIndex={selectedIndex}
          onNavigateDetail={handleNavigateDetail}
          t={t}
        />
      </div>
    </LogPanelHeaderContext.Provider>
  )
}

interface MainContentProps {
  showTimeline: boolean
  viewMode: LogPanelFilterState["viewMode"]
  filteredLogs: StructuredLogEntry[]
  paginatedLogs: StructuredLogEntry[]
  customTimeRange: { start: Date; end: Date } | null
  handleCustomTimeRangeChange: (range: { start: Date; end: Date } | null) => void
  logRate: number
  nativeLogging: ReturnType<typeof useTransportHealth>["nativeLogging"]
  handleSearchQueryChange: (value: string) => void
  groupByTraceId: boolean
  displayedGroupedLogs: Map<string, StructuredLogEntry[]>
  filters: LogPanelFilterState
  handleFocusTrace: (traceId: string, log: StructuredLogEntry) => void
  handleFocusSession: (sessionId: string, log: StructuredLogEntry) => void
  handleTraceFocusChange: (value: string | null) => void
  emptyStateActiveFilterLabels: string[]
  handleClearAllFilters: () => void
  isLoading: boolean
  error: Error | null
  refresh: () => void
  scrollRef: React.RefObject<HTMLDivElement | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  isDesktopViewport: boolean
  relatedLogs: StructuredLogEntry[]
  resizableLayout: UseResizableLayoutResult
  density: LogPanelFilterState["density"]
  selectedIndex: number
  onNavigateDetail: (delta: -1 | 1) => void
  t: ReturnType<typeof useTranslations>
}

function MainContent({
  showTimeline,
  viewMode,
  filteredLogs,
  paginatedLogs,
  customTimeRange,
  handleCustomTimeRangeChange,
  logRate,
  nativeLogging,
  handleSearchQueryChange,
  groupByTraceId,
  displayedGroupedLogs,
  filters,
  handleFocusTrace,
  handleFocusSession,
  handleTraceFocusChange,
  emptyStateActiveFilterLabels,
  handleClearAllFilters,
  isLoading,
  error,
  refresh,
  scrollRef,
  containerRef,
  isDesktopViewport,
  relatedLogs,
  resizableLayout,
  density,
  selectedIndex,
  onNavigateDetail,
  t,
}: MainContentProps) {
  const detailOpen = filters.showDetailPanel && Boolean(filters.selectedLog) && isDesktopViewport
  const selectedLogId =
    filters.showDetailPanel && filters.selectedLog ? filters.selectedLog.id : null

  const renderMain = () => (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="log-panel-main-pane">
      {showTimeline && viewMode === "list" && (
        <LogTimeline
          logs={filteredLogs}
          selectedRange={customTimeRange}
          onTimeRangeClick={(start, end) => handleCustomTimeRangeChange({ start, end })}
          onClearRange={() => handleCustomTimeRangeChange(null)}
        />
      )}

      {viewMode === "dashboard" ? (
        <ScrollArea className="flex-1">
          <LogStatsDashboard
            logs={filteredLogs}
            logRate={logRate}
            nativeLogging={nativeLogging}
            onSearchFilter={handleSearchQueryChange}
          />
        </ScrollArea>
      ) : viewMode === "trace" ? (
        <ScrollArea className="flex-1">
          <LogTraceView
            filteredLogs={filteredLogs}
            onSelectTrace={(id) => handleTraceFocusChange(id)}
          />
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
          selectedLogId={selectedLogId}
          density={density}
          t={t}
          onRetry={refresh}
          emptyStateContext={{
            activeFilterLabels: emptyStateActiveFilterLabels,
            onClearFilters:
              emptyStateActiveFilterLabels.length > 0 ? handleClearAllFilters : undefined,
            onOpenPresets:
              filters.presets.length > 0 ? () => filters.setShowAdvancedFilters(true) : undefined,
          }}
        />
      )}
    </div>
  )

  const renderDetailPanel = (className?: string) =>
    filters.selectedLog ? (
      <LogDetailPanel
        log={filters.selectedLog}
        relatedLogs={relatedLogs}
        isBookmarked={filters.bookmarkedIds.has(filters.selectedLog.id)}
        onClose={() => filters.setShowDetailPanel(false)}
        onToggleBookmark={filters.toggleBookmark}
        onSelectRelated={(log) => filters.setSelectedLog(log)}
        onNavigate={selectedIndex >= 0 ? onNavigateDetail : undefined}
        navPosition={
          selectedIndex >= 0 ? { index: selectedIndex + 1, total: paginatedLogs.length } : undefined
        }
        className={className}
      />
    ) : null

  // Only persist splits that actually contain both panels — when the detail
  // panel is closed the group reports a single 100% pane, which would
  // clobber the user's saved 70/30 split.
  const handleLayoutChanged = (layout: Record<string, number>) => {
    if (Object.keys(layout).length > 1) resizableLayout.onLayoutChanged(layout)
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* The panel group stays mounted whether or not the detail panel is
          open, so toggling the detail view never remounts the timeline or the
          virtualized list (a full remount re-created every row and dropped
          the scroll position — the source of the open-detail jank). */}
      <div className="flex-1" data-testid="log-panel-resizable-group">
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1"
          defaultLayout={resizableLayout.defaultLayout}
          onLayoutChanged={handleLayoutChanged}
        >
          <ResizablePanel id="log-panel-main" defaultSize="70%" minSize="50%">
            {renderMain()}
          </ResizablePanel>
          {detailOpen && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel id="log-panel-detail" defaultSize="30%" minSize="20%" maxSize="50%">
                {renderDetailPanel("h-full border-0")}
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>

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
            className="h-[85vh] md:h-[75vh] lg:h-[80vh] p-0 flex flex-col"
            data-testid="log-detail-sheet"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{t("panel.logDetails")}</SheetTitle>
              <SheetDescription>{t("panel.logDetails")}</SheetDescription>
            </SheetHeader>
            {renderDetailPanel("flex-1 border-0")}
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}

export default LogPanel
