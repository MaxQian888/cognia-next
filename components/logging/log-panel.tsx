"use client"

/**
 * LogPanel
 *
 * A comprehensive log viewing component that aggregates logs from multiple sources
 * (frontend, Tauri, MCP, plugins) with filtering, grouping, and export capabilities.
 *
 * Composed from extracted sub-components:
 * - LogPanelToolbar — view mode, search, filters, actions, transport health
 * - LogPanelStatsBar — ingest rate and loaded-window note
 * - VirtualizedLogList — virtualized log list (a listbox with a roving tab stop)
 * - LogDetailPanel — log detail view
 * - LogStatsDashboard — analytics dashboard
 * - LogTimeline — density timeline
 *
 * There is no pagination. The list is virtualized over the whole loaded window,
 * so the keyboard cursor, the detail pane's previous / next, a related-entry
 * click and a deep-linked `sel` all address the same rows; with pages, j / k and
 * the detail arrows stopped dead at the page edge and a related entry on another
 * page could be opened but not stepped from.
 */

import { useRef, useEffect, useCallback, useMemo, useState, useDeferredValue } from "react"
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
  createLogSearchMatcher,
  type UseTransportHealthResult,
} from "@/hooks/logging"
import {
  useLogPanelFilters,
  type Density,
  type LogPanelFilterState,
  type PanelSource,
} from "@/hooks/logging/use-log-panel-filters"
import { useLogPanelUrlSync } from "@/hooks/logging/use-log-panel-url-sync"
import { useElementWidth } from "@/hooks/use-element-width"
import { LogPanelToolbar, type ExportFormat } from "./log-panel-toolbar"
import { AgentTraceStatsBar } from "./agent-trace-stats-bar"
import {
  LogPanelStatsBar,
  TransportHealthDetail,
  TransportHealthSummary,
  NativeLoggingDetail,
} from "./log-panel-stats-bar"
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useIsNarrow, useResizableLayout, type UseResizableLayoutResult } from "@/hooks/ui"
import { AGENT_TRACE_MODULE } from "@cognia/agent-trace/log-adapter"
import type { AgentTraceStatsWindow } from "@/lib/observability/trace-window"
import type { PresetTimeRange } from "@/types/logging"
import type { LogLevel, StructuredLogEntry } from "@cognia/logging"

// Time range options in milliseconds
const TIME_RANGES = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  all: 0,
} as const

const TIME_RANGE_LABEL_KEYS: Record<
  Exclude<PresetTimeRange, "all">,
  | "panel.timeRange15m"
  | "panel.timeRange1h"
  | "panel.timeRange6h"
  | "panel.timeRange24h"
  | "panel.timeRange7d"
> = {
  "15m": "panel.timeRange15m",
  "1h": "panel.timeRange1h",
  "6h": "panel.timeRange6h",
  "24h": "panel.timeRange24h",
  "7d": "panel.timeRange7d",
}

const ALL_PANEL_SOURCES: PanelSource[] = ["frontend", "tauri", "mcp", "plugin", "internal"]
/**
 * How many entries the panel loads. Every client-side filter (search, level,
 * source, time range, session, bookmarks) narrows inside this window; module
 * and trace are pushed to the store, so they reach past it. The stats bar and
 * the empty state say so when the window is full.
 */
const LOG_WINDOW_SIZE = 1000
const NEW_LOG_TOAST_THROTTLE_MS = 5000
/**
 * The panel's own width at which the detail pane docks beside the list. It is
 * the panel that has to fit two panes, not the window: inside `/logs` the
 * channel rail and the app sidebar already take ~500px of a 1280px viewport,
 * and in Settings → MCP the panel is a card. A viewport query docked a 30%
 * pane into a 780px panel and opened a drawer over a 1600px one.
 */
const DETAIL_SIDE_PANE_MIN_WIDTH = 960
/**
 * When the user last cleared the log store (ISO). See `useClearedAt`.
 * Global, not per embed: the store it describes is global.
 */
const CLEARED_AT_STORAGE_KEY = "cognia-log-cleared-at"

/** The transport-health shape a host can hand down instead of the panel polling. */
export type LogPanelTransportHealth = Pick<
  UseTransportHealthResult,
  "healthByTransport" | "queueDepthHistoryByTransport" | "nativeLogging"
>

export interface LogPanelProps {
  className?: string
  maxHeight?: string
  defaultAutoRefresh?: boolean
  refreshInterval?: number
  showStats?: boolean
  showTimeline?: boolean
  sources?: ("frontend" | "tauri" | "mcp" | "plugin")[]
  includeAgentTrace?: boolean
  /**
   * Row density, controlled by the host. Pass both to make the host the single
   * source of truth; omit both and the panel keeps its own localStorage-backed
   * preference. Passing only one leaves the panel uncontrolled — a control that
   * cannot write back is worse than no control at all.
   */
  density?: Density
  onDensityChange?: (density: Density) => void
  /**
   * Opens an agent trace in the host's trace explorer. Offered on entries
   * whose trace carries agent-trace spans (the detail pane and the trace
   * view); omit it where there is no explorer to open.
   */
  onOpenTrace?: (traceId: string) => void
  /**
   * The host's transport-health poll. `/logs` already polls for its header
   * pill; given this, the panel renders that data and starts no poll of its
   * own (two intervals on one page also disagreed for up to a tick).
   */
  transportHealth?: LogPanelTransportHealth
  /**
   * Namespace for per-embed preferences (live follow — see
   * `useLogPanelFilters`). Omit for `/logs`; an embed passes its own, so
   * turning Live off in one place no longer turns it off in the other.
   */
  storageScope?: string
}

/**
 * Whether `log` sits under the level tab `levelFilter`. Tabs are exact: the
 * store's own `level` filter is a minimum ("warn" = warn + error + fatal), and
 * pushing the tab down to it made the Warning tab, badged 16, list 64 rows.
 * Error is the one merged tab — it carries fatal, as its badge always has.
 */
function matchesLevelTab(log: StructuredLogEntry, levelFilter: LogLevel | "all"): boolean {
  if (levelFilter === "all") return true
  if (levelFilter === "error" || levelFilter === "fatal") {
    return log.level === "error" || log.level === "fatal"
  }
  return log.level === levelFilter
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

/**
 * The agent-trace stats window that covers the panel's time range: the
 * smallest of today / week / month / all whose lower bound is at or before the
 * range's start. The stats bar was pinned to "today", so with the list on
 * "last 7 days" its cost and error numbers described a fraction of the rows
 * under it. The windows are coarser than the presets ("last 6h" at 02:00
 * reaches into yesterday, so it reads as the week), which is why this picks
 * the covering window rather than the nearest one.
 */
export function agentTraceWindowForRange(
  timeRange: PresetTimeRange,
  customTimeRange: { start: Date; end: Date } | null,
  now: number = Date.now()
): AgentTraceStatsWindow {
  const start = customTimeRange
    ? customTimeRange.start.getTime()
    : timeRange === "all"
      ? null
      : now - TIME_RANGES[timeRange]
  if (start === null) return "all"
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  if (start >= midnight.getTime()) return "today"
  if (start >= now - TIME_RANGES["7d"]) return "week"
  if (start >= now - 30 * 24 * 60 * 60 * 1000) return "month"
  return "all"
}

/**
 * When the log store was last cleared, persisted across mounts.
 *
 * Clearing empties the unified IndexedDB log store, but the agent-trace spans
 * the panel merges in live in their own Dexie table — the one the Traces
 * channel reads, with its own retention — and "Clear logs" must not delete
 * the trace history another channel shows. Without this the spans came
 * straight back the moment the list re-rendered, so "Logs cleared" left a
 * list that was visibly not clear. The panel hides spans older than the clear
 * instead; newer spans appear as they are written.
 */
function useClearedAt(): [string | null, (at: string) => void] {
  const [clearedAt, setClearedAtState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null
    try {
      return window.localStorage.getItem(CLEARED_AT_STORAGE_KEY)
    } catch {
      return null
    }
  })
  const setClearedAt = useCallback((at: string) => {
    setClearedAtState(at)
    try {
      window.localStorage.setItem(CLEARED_AT_STORAGE_KEY, at)
    } catch {
      // ignore storage quota / private-mode errors
    }
  }, [])
  return [clearedAt, setClearedAt]
}

/** Escape inside one of these belongs to the popup, never to the panel. */
const POPUP_SELECTOR =
  '[role="menu"],[role="listbox"]:not([data-log-list]),[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper]'

export function LogPanel({
  className,
  maxHeight,
  defaultAutoRefresh = false,
  refreshInterval = 2000,
  showStats = true,
  showTimeline = true,
  sources,
  includeAgentTrace = true,
  density,
  onDensityChange,
  onOpenTrace,
  transportHealth,
  storageScope,
}: LogPanelProps) {
  const t = useTranslations("logging")
  const filters = useLogPanelFilters({
    defaultAutoRefresh,
    sources,
    density,
    onDensityChange,
    storageScope,
  })
  // Destructure the identity-stable setters once. Handlers below depend on
  // these instead of the whole `filters` object — otherwise ANY of its ~30
  // state fields changing (selected log, expanded row, arrow-key focus, every
  // poll) would recreate every callback and defeat the toolbar/row memoization.
  const {
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
    setBookmarkFilterActive,
    setShowShortcutsDialog,
    setSelectedLog,
    setShowDetailPanel,
    setViewMode,
    setSelectedTransportHealthName,
    setSelectedNativeLogging,
  } = filters
  const rootRef = useRef<HTMLDivElement>(null)
  // `0` until measured (see `useElementWidth`), which reads as "not wide".
  const panelWidth = useElementWidth(rootRef)
  const sideDetail = panelWidth >= DETAIL_SIDE_PANE_MIN_WIDTH
  const narrow = useIsNarrow()
  const deferredSearchQuery = useDeferredValue(filters.searchQuery)
  const { customTimeRange } = filters

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

  // Called unconditionally (rules of hooks) but idle when the host hands its
  // own poll down, or when nothing renders health at all.
  const ownTransportHealth = useTransportHealth({
    enabled: !transportHealth && showStats,
    autoRefresh: true,
    refreshInterval: Math.max(refreshInterval, 1500),
  })
  const { healthByTransport, queueDepthHistoryByTransport, nativeLogging } =
    transportHealth ?? ownTransportHealth

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
  // No `level` here: the level tabs filter client-side (see `matchesLevelTab`)
  // so the tab badges can be counted over the same rows the tabs select from.
  const { logs, isLoading, error, refresh, clearLogs, logRate, windowCapped } = useLogStream({
    autoRefresh: filters.autoRefresh,
    refreshInterval,
    module:
      filters.moduleFilter === "all" || filters.moduleFilter === AGENT_TRACE_MODULE
        ? undefined
        : filters.moduleFilter,
    traceId: filters.traceFocusId || undefined,
    searchQuery: deferredSearchQuery || undefined,
    useRegex: filters.useRegex,
    maxLogs: LOG_WINDOW_SIZE,
  })

  // Live off freezes the span rows exactly as it stops the store poll; a
  // manual refresh (button or `r`) re-reads both.
  const [traceRefreshToken, setTraceRefreshToken] = useState(0)
  const agentTraceLogs = useAgentTraceAsLogs({
    enabled: includeAgentTrace,
    maxLogs: 200,
    live: filters.autoRefresh,
    refreshToken: traceRefreshToken,
  })
  const handleRefresh = useCallback(() => {
    setTraceRefreshToken((token) => token + 1)
    void refresh()
  }, [refresh])

  const [clearedAt, setClearedAt] = useClearedAt()

  // The span rows go through the same search as the store's rows. They used
  // to skip it, so a search narrowed the list but every span still showed —
  // and the level badges, counted over the merged set, disagreed with the
  // store-side count of the same search.
  const visibleSpans = useMemo(() => {
    const matches = createLogSearchMatcher(deferredSearchQuery || undefined, filters.useRegex)
    if (!matches && !clearedAt) return agentTraceLogs.logs
    return agentTraceLogs.logs.filter(
      (log) => (!clearedAt || log.timestamp > clearedAt) && (!matches || matches(log))
    )
  }, [agentTraceLogs.logs, deferredSearchQuery, filters.useRegex, clearedAt])

  // Merged and filtered logs.
  // Both inputs come from `useLogStream` / `useAgentTraceAsLogs`, which
  // produce timestamp-descending arrays. A linear two-pointer merge is O(n+m)
  // and avoids the per-poll O(n log n) sort + allocation of a doubled array.
  const mergedLogs = useMemo(() => {
    if (!includeAgentTrace || visibleSpans.length === 0) return logs
    const a = logs
    const b = visibleSpans
    const limit = Math.min(LOG_WINDOW_SIZE, a.length + b.length)
    // Span-shaped entries are persisted twice: the trace transport writes
    // them into the unified log store (→ `logs`) and into the agentTraces
    // Dexie table (→ `agentTraceLogs`), both keyed by `span.id`. Dedup on
    // `id` so each span renders once — otherwise React hits duplicate-key
    // warnings on every refresh tick.
    const out: StructuredLogEntry[] = []
    const seen = new Set<string>()
    let ai = 0
    let bi = 0
    while (out.length < limit && (ai < a.length || bi < b.length)) {
      let next: StructuredLogEntry
      if (ai >= a.length) {
        next = b[bi++]
      } else if (bi >= b.length) {
        next = a[ai++]
      } else if (a[ai].timestamp >= b[bi].timestamp) {
        next = a[ai++]
      } else {
        next = b[bi++]
      }
      if (seen.has(next.id)) continue
      seen.add(next.id)
      out.push(next)
    }
    return out
  }, [logs, visibleSpans, includeAgentTrace])

  const augmentedModules = useMemo(() => {
    if (!includeAgentTrace) return modules
    return modules.includes(AGENT_TRACE_MODULE) ? modules : [...modules, AGENT_TRACE_MODULE]
  }, [modules, includeAgentTrace])

  const getTimeRangeCutoff = useCallback(() => {
    if (filters.timeRange === "all") return 0
    return Date.now() - TIME_RANGES[filters.timeRange]
  }, [filters.timeRange])

  /**
   * Every filter except the level tab and the bookmark tab — the controls
   * that live on the level row. The badges on that row are counted over this
   * set, which is what makes a badge equal the number of rows its tab shows.
   * The dashboard draws this set too: it charts the level mix, so drawing it
   * after the level tab had already removed every other level made the pie a
   * single slice.
   */
  const facetBaseLogs = useMemo(() => {
    // Hoist all filter inputs once so each predicate is a constant-time check.
    const moduleFilter = filters.moduleFilter
    const moduleIsAgentTrace = moduleFilter === AGENT_TRACE_MODULE
    const moduleIsSpecific = moduleFilter !== "all" && !moduleIsAgentTrace
    const customStartMs = customTimeRange?.start.getTime() ?? 0
    const customEndMs = customTimeRange?.end.getTime() ?? 0
    const hasCustomTimeRange = customTimeRange !== null
    const hasPresetTimeRange = !hasCustomTimeRange && filters.timeRange !== "all"
    const presetCutoff = hasPresetTimeRange ? getTimeRangeCutoff() : 0
    const traceFocusId = filters.traceFocusId
    const sessionFilterTrimmed = filters.sessionFilter.trim()
    const hasSessionFilter = sessionFilterTrimmed.length > 0
    const diagnosticTransport = filters.diagnosticTransportFilter
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

      if (traceFocusId && log.traceId !== traceFocusId) continue
      if (hasSessionFilter && log.sessionId !== sessionFilterTrimmed) continue
      if (diagnosticTransport) {
        if (log.module !== "logger.internal") continue
        if (String(log.data?.sourceTransport || "") !== diagnosticTransport) continue
      }

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
    filters.traceFocusId,
    filters.sessionFilter,
    filters.diagnosticTransportFilter,
    customTimeRange,
  ])

  const filteredLogs = useMemo(() => {
    const levelFilter = filters.levelFilter
    const bookmarkFilterActive = filters.bookmarkFilterActive
    const bookmarkedIds = filters.bookmarkedIds
    if (levelFilter === "all" && !bookmarkFilterActive) return facetBaseLogs
    return facetBaseLogs.filter(
      (log) =>
        matchesLevelTab(log, levelFilter) && (!bookmarkFilterActive || bookmarkedIds.has(log.id))
    )
  }, [facetBaseLogs, filters.levelFilter, filters.bookmarkFilterActive, filters.bookmarkedIds])

  const facetStats = useMemo(() => {
    const byLevel = {} as Record<LogLevel, number>
    let bookmarked = 0
    for (const log of facetBaseLogs) {
      byLevel[log.level] = (byLevel[log.level] ?? 0) + 1
      if (filters.bookmarkedIds.has(log.id)) bookmarked++
    }
    return { total: facetBaseLogs.length, byLevel, bookmarked }
  }, [facetBaseLogs, filters.bookmarkedIds])

  useLogPanelUrlSync(filters, { logs: mergedLogs, logsReady: !isLoading })

  useEffect(() => {
    setFocusedIndex((prev) => {
      if (prev < 0 || filteredLogs.length === 0) return -1
      return Math.min(prev, filteredLogs.length - 1)
    })
  }, [setFocusedIndex, filteredLogs.length])

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
        customTimeRange: state.filters.customTimeRange
          ? {
              start: state.filters.customTimeRange.start.toISOString(),
              end: state.filters.customTimeRange.end.toISOString(),
            }
          : null,
        searchQuery: state.filters.searchQuery,
        useRegex: state.filters.useRegex,
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
        // Full-fidelity columns: trace/session/source/data used to be dropped,
        // which made CSV exports useless for correlating incidents.
        const esc = (value: string) => `"${value.replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`
        const csvHeader =
          '"Timestamp","Level","Module","Message","TraceId","SessionId","Source","Data"\n'
        const csvContent = bundle.logs
          .map((log) =>
            [
              esc(new Date(log.timestamp).toISOString()),
              esc(log.level),
              esc(log.module),
              esc(log.message),
              esc(log.traceId ?? ""),
              esc(log.sessionId ?? ""),
              esc(log.source ? JSON.stringify(log.source) : ""),
              esc(log.data ? JSON.stringify(log.data) : ""),
            ].join(",")
          )
          .join("\n")
        downloadBlob(createExportBlob(csvHeader + csvContent, "text/csv"), "csv")
        return
      }
      if (format === "ndjson") {
        // One JSON entry per line — streams into jq / Loki / Grafana without
        // loading the whole export as a single document.
        const ndjson = bundle.logs.map((log) => JSON.stringify(log)).join("\n")
        downloadBlob(createExportBlob(ndjson, "application/x-ndjson"), "ndjson")
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

  // Clearing is destructive and irreversible — gate it behind a confirmation
  // dialog instead of firing straight from the More menu. The toast reports
  // what happened, so it waits for the clear: "Logs cleared" used to appear
  // the instant the dialog closed, including when the clear then failed.
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)
  const handleClearRequest = useCallback(() => setConfirmClearOpen(true), [])
  const handleClearConfirm = useCallback(() => {
    setConfirmClearOpen(false)
    clearLogs().then(
      () => {
        setClearedAt(new Date().toISOString())
        // The selected entry no longer exists.
        setSelectedLog(null)
        setShowDetailPanel(false)
        setFocusedIndex(-1)
        toast.success(t("panel.clearedToast"))
      },
      (err: unknown) => {
        toast.error(t("panel.clearFailedToast"), {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    )
  }, [clearLogs, setClearedAt, setSelectedLog, setShowDetailPanel, setFocusedIndex, t])

  // Read from the merged stream rather than the store's alone, so a span the
  // agent-trace table contributed still shows up as a neighbour of the log
  // lines written under the same trace.
  const relatedLogs = useMemo(() => {
    const traceId = filters.selectedLog?.traceId
    if (!traceId) return []
    return mergedLogs.filter((l) => l.traceId === traceId)
  }, [mergedLogs, filters.selectedLog])

  /** Narrowing changes the rows under the cursor: drop it and go to the top. */
  const resetCursor = useCallback(() => {
    setFocusedIndex(-1)
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [setFocusedIndex])

  const handleSearchQueryChange = useCallback(
    (value: string) => {
      resetCursor()
      setSearchQuery(value)
    },
    [setSearchQuery, resetCursor]
  )

  const handleUseRegexChange = useCallback(
    (value: boolean) => {
      resetCursor()
      setUseRegex(value)
    },
    [setUseRegex, resetCursor]
  )

  const handleLevelFilterChange = useCallback(
    (value: LogPanelFilterState["levelFilter"]) => {
      resetCursor()
      setLevelFilter(value)
    },
    [setLevelFilter, resetCursor]
  )

  const handleModuleFilterChange = useCallback(
    (value: string) => {
      resetCursor()
      setModuleFilter(value)
    },
    [setModuleFilter, resetCursor]
  )

  const handleSourceFilterChange = useCallback(
    (value: PanelSource | "all") => {
      resetCursor()
      setSourceFilter(value)
    },
    [setSourceFilter, resetCursor]
  )

  const handleSessionFilterChange = useCallback(
    (value: string) => {
      resetCursor()
      setSessionFilter(value)
    },
    [setSessionFilter, resetCursor]
  )

  const handleTimeRangeChange = useCallback(
    (value: LogPanelFilterState["timeRange"]) => {
      resetCursor()
      setTimeRange(value)
    },
    [setTimeRange, resetCursor]
  )

  // Active filters for the empty state, as the user would name them — this
  // printed `level=error` / `source=tauri`, the panel's internal keys.
  const emptyStateActiveFilterLabels = useMemo(() => {
    const labels: string[] = []
    if (filters.levelFilter !== "all") {
      labels.push(t("panel.emptyChips.level", { value: t(`levels.${filters.levelFilter}`) }))
    }
    if (filters.moduleFilter !== "all") {
      labels.push(
        t("panel.emptyChips.module", {
          value:
            filters.moduleFilter === AGENT_TRACE_MODULE
              ? t("panel.agentTraceModule")
              : filters.moduleFilter,
        })
      )
    }
    if (filters.sourceFilter !== "all") {
      labels.push(
        t("panel.emptyChips.source", { value: t(`panel.sources.${filters.sourceFilter}`) })
      )
    }
    if (filters.sessionFilter.trim()) {
      labels.push(t("panel.emptyChips.session", { value: filters.sessionFilter.trim() }))
    }
    if (customTimeRange) labels.push(t("panel.emptyChips.customTime"))
    else if (filters.timeRange !== "all") {
      labels.push(
        t("panel.emptyChips.time", { value: t(TIME_RANGE_LABEL_KEYS[filters.timeRange]) })
      )
    }
    if (filters.searchQuery.trim()) {
      labels.push(t("panel.emptyChips.search", { value: filters.searchQuery.trim() }))
    }
    if (filters.traceFocusId) {
      labels.push(t("panel.emptyChips.trace", { value: filters.traceFocusId.slice(0, 12) }))
    }
    if (filters.diagnosticTransportFilter) {
      labels.push(t("panel.emptyChips.transport", { value: filters.diagnosticTransportFilter }))
    }
    if (filters.bookmarkFilterActive) labels.push(t("panel.emptyChips.bookmarks"))
    return labels
  }, [
    t,
    customTimeRange,
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

  // A custom range is a filter too; leaving it behind made "Clear filters" on
  // an empty list land on another empty list.
  const handleClearAllFilters = useCallback(() => {
    resetCursor()
    setLevelFilter("all")
    setModuleFilter("all")
    setSourceFilter("all")
    setSessionFilter("")
    setTimeRange("all")
    setCustomTimeRange(null)
    setSearchQuery("")
    setTraceFocusId(null)
    setDiagnosticTransportFilter(null)
    setBookmarkFilterActive(false)
  }, [
    resetCursor,
    setLevelFilter,
    setModuleFilter,
    setSourceFilter,
    setSessionFilter,
    setTimeRange,
    setCustomTimeRange,
    setSearchQuery,
    setTraceFocusId,
    setDiagnosticTransportFilter,
    setBookmarkFilterActive,
  ])

  /** Facet-only reset for the chip row: the search box and the level row keep
   * their own state, because they are visible controls of their own and the
   * chip row never rendered them. */
  const handleClearFacets = useCallback(() => {
    resetCursor()
    setModuleFilter("all")
    setSourceFilter("all")
    setSessionFilter("")
    setTimeRange("all")
    setCustomTimeRange(null)
    setTraceFocusId(null)
    setDiagnosticTransportFilter(null)
  }, [
    resetCursor,
    setModuleFilter,
    setSourceFilter,
    setSessionFilter,
    setTimeRange,
    setCustomTimeRange,
    setTraceFocusId,
    setDiagnosticTransportFilter,
  ])

  const handleTraceFocusChange = useCallback(
    (value: string | null) => {
      resetCursor()
      setTraceFocusId(value)
    },
    [setTraceFocusId, resetCursor]
  )

  const applyPresetById = filters.handlePresetChange
  const handlePresetChange = useCallback(
    (presetId: string) => {
      resetCursor()
      applyPresetById(presetId)
    },
    [applyPresetById, resetCursor]
  )

  // Narrowing to a trace / session leaves the detail pane as it was — see
  // `useLogPanelFilters.handleFocusTrace`.
  const focusTrace = filters.handleFocusTrace
  const handleFocusTrace = useCallback(
    (traceId: string, log: StructuredLogEntry) => {
      resetCursor()
      focusTrace(traceId, log)
    },
    [focusTrace, resetCursor]
  )

  const focusSession = filters.handleFocusSession
  const handleFocusSession = useCallback(
    (sessionId: string, log: StructuredLogEntry) => {
      resetCursor()
      focusSession(sessionId, log)
    },
    [focusSession, resetCursor]
  )

  const handleDiagnosticTransportFilterChange = useCallback(
    (value: string | null) => {
      resetCursor()
      setDiagnosticTransportFilter(value)
    },
    [setDiagnosticTransportFilter, resetCursor]
  )

  const handleCustomTimeRangeChange = useCallback(
    (range: { start: Date; end: Date } | null) => {
      resetCursor()
      setCustomTimeRange(range)
    },
    [setCustomTimeRange, resetCursor]
  )

  /**
   * The dashboard's click-throughs. Each narrows the list and *goes to it*:
   * "Top errors" used to write the search box and leave the user on the
   * dashboard, where the only visible effect was every chart redrawing over
   * the narrower set — the rows they had asked for were one toggle away.
   */
  const handleDashboardSearch = useCallback(
    (query: string) => {
      // The query is an error message, matched literally. With regex on, a
      // message with a "(" or a "?" in it failed to compile or matched other
      // rows than the ones counted.
      setUseRegex(false)
      handleSearchQueryChange(query)
      setViewMode("list")
    },
    [handleSearchQueryChange, setUseRegex, setViewMode]
  )
  const handleDashboardModule = useCallback(
    (moduleName: string) => {
      handleModuleFilterChange(moduleName)
      setViewMode("list")
    },
    [handleModuleFilterChange, setViewMode]
  )
  const handleDashboardLevel = useCallback(
    (level: LogLevel) => {
      resetCursor()
      setLevelFilter(level === "fatal" ? "error" : level)
      setBookmarkFilterActive(false)
      setViewMode("list")
    },
    [resetCursor, setLevelFilter, setBookmarkFilterActive, setViewMode]
  )
  /** The trace view's rows narrow the list to one trace and show it. */
  const handleTraceViewSelect = useCallback(
    (traceId: string) => {
      handleTraceFocusChange(traceId)
      setViewMode("list")
    },
    [handleTraceFocusChange, setViewMode]
  )

  // The bands under the toolbar are one slot: opening the transport band
  // closes the native one and vice versa, so they can never stack two
  // full-width panels over the list.
  const openTransportBand = useCallback(
    (name: string) => {
      setSelectedNativeLogging(false)
      setSelectedTransportHealthName(name)
    },
    [setSelectedNativeLogging, setSelectedTransportHealthName]
  )
  const openNativeBand = useCallback(() => {
    setSelectedTransportHealthName(null)
    setSelectedNativeLogging(true)
  }, [setSelectedNativeLogging, setSelectedTransportHealthName])

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

  const hasTraceIds = useMemo(() => mergedLogs.some((log) => Boolean(log.traceId)), [mergedLogs])
  const traceViewAvailable = includeAgentTrace || hasTraceIds

  // Keyboard shortcuts — attached to `window` so the panel listens regardless
  // of where focus currently sits (previously bound to the virtualizer host
  // div, which silently broke shortcuts when focus was elsewhere). The effect
  // re-attaches whenever the captured values change; since the listener target
  // is `window`, attach/detach is O(1) and harmless during polling.
  useEffect(() => {
    if (typeof window === "undefined") return
    const handleKeyDown = (e: KeyboardEvent) => {
      // A row, a control or a popup that already handled the key owns it.
      // Radix calls `preventDefault` on the Escape that dismisses a menu,
      // select or popover, which is what keeps that Escape from also clearing
      // the search or closing the detail pane.
      if (e.defaultPrevented) return
      // Ignore shortcuts while the user is typing in any text input.
      const target = e.target as HTMLElement | null
      // `window` itself can be the target (a synthetic dispatch); it has no
      // ancestors to inspect.
      const targetElement = target instanceof Element ? target : null
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
        const openDialog = document.querySelector(
          'div[role="dialog"][data-state="open"],div[role="alertdialog"][data-state="open"]'
        )
        if (openDialog) return
      }
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey
      const inList = filters.viewMode === "list"

      if (e.key === "r" && plain) {
        e.preventDefault()
        handleRefresh()
      } else if (e.key === "Escape") {
        // Belt and braces for a popup that closes without preventing the
        // default: focus still inside it means the Escape was its.
        if (targetElement?.closest(POPUP_SELECTOR)) return
        if (filters.showDetailPanel && filters.selectedLog) setShowDetailPanel(false)
        else if (filters.searchQuery) handleSearchQueryChange("")
      } else if (e.key === "d" && plain) {
        e.preventDefault()
        setViewMode((prev) => (prev === "dashboard" ? "list" : "dashboard"))
      } else if (e.key === "t" && plain && traceViewAvailable) {
        e.preventDefault()
        setViewMode((prev) => (prev === "trace" ? "list" : "trace"))
      } else if (e.key === "/" && plain) {
        e.preventDefault()
        rootRef.current
          ?.querySelector<HTMLInputElement>(
            '[data-testid="log-panel-toolbar"] input[role="combobox"]'
          )
          ?.focus()
      } else if (e.key === "b" && plain) {
        const focused = filters.focusedIndex
        if (inList && focused >= 0 && focused < filteredLogs.length) {
          e.preventDefault()
          filters.toggleBookmark(filteredLogs[focused].id)
        }
      } else if (e.key === "g" && plain) {
        e.preventDefault()
        filters.setShowAdvancedFilters(true)
        // Next frame, so the preset select has mounted. A Radix select opens
        // on pointerdown or an open key, never on `click()` — which is all
        // this used to send, along with a fallback selector for a header
        // preset control that no longer exists.
        requestAnimationFrame(() => {
          const trigger = rootRef.current?.querySelector<HTMLButtonElement>(
            '[data-testid="log-panel-preset-trigger"]'
          )
          if (!trigger) return
          trigger.focus()
          trigger.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
          )
        })
      } else if (e.key === "ArrowDown" || e.key === "j" || e.key === "ArrowUp" || e.key === "k") {
        if (!plain) return
        // Arrow keys belong to whatever owns them when focus is inside a
        // menu, another listbox, a slider or the resize handle. The log list
        // is a listbox too, but its arrows are exactly these.
        if (
          (e.key === "ArrowDown" || e.key === "ArrowUp") &&
          targetElement?.closest(
            '[role="menu"],[role="listbox"]:not([data-log-list]),[role="slider"],[role="separator"]'
          )
        ) {
          return
        }
        if (!inList || filteredLogs.length === 0) return
        e.preventDefault()
        const step = e.key === "ArrowDown" || e.key === "j" ? 1 : -1
        const current = filters.focusedIndex
        const next =
          current < 0
            ? step > 0
              ? 0
              : filteredLogs.length - 1
            : Math.min(Math.max(current + step, 0), filteredLogs.length - 1)
        setFocusedIndex(next)
        // With the detail pane open, the cursor carries the selection — the
        // pane follows the keyboard the way a mail client's reading pane does.
        if (filters.showDetailPanel && filters.selectedLog) {
          setSelectedLog(filteredLogs[next])
        }
      } else if (
        e.key === "e" &&
        plain &&
        inList &&
        filters.focusedIndex >= 0 &&
        filters.focusedIndex < filteredLogs.length
      ) {
        // Expand in place — the chevron's job. Enter used to do this while a
        // click opened nothing; Enter and click now both open the entry.
        e.preventDefault()
        filters.toggleExpanded(filteredLogs[filters.focusedIndex].id)
      } else if (
        (e.key === "Enter" || e.key === "o") &&
        plain &&
        inList &&
        filters.focusedIndex >= 0 &&
        filters.focusedIndex < filteredLogs.length
      ) {
        // Enter on a button / link is that control's own activation.
        if (e.key === "Enter" && targetElement?.closest("button,a,[role='menuitem']")) return
        e.preventDefault()
        filters.handleSelectLog(filteredLogs[filters.focusedIndex])
      } else if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        setShowShortcutsDialog(true)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [
    filters,
    filteredLogs,
    handleRefresh,
    handleSearchQueryChange,
    traceViewAvailable,
    setFocusedIndex,
    setSelectedLog,
    setShowDetailPanel,
    setShowShortcutsDialog,
    setViewMode,
  ])

  // Auto-scroll / new-logs toast.
  //
  // Following (live + auto-scroll on, list showing) keeps the newest-first
  // list at its top. With auto-scroll paused — the user is reading somewhere
  // below — a throttled toast offers "Jump to latest" instead of yanking the
  // list out from under them.
  // Arrivals are counted by timestamp, not by `logs.length`: the stream is
  // capped at the window size, and once it was full every poll replaced the
  // oldest entries one-for-one, the length stopped moving, and neither the
  // follow-scroll nor the "new entries" toast ever fired again.
  const lastSeenNewestRef = useRef<string | null>(logs[0]?.timestamp ?? null)
  const lastToastAtRef = useRef(0)
  useEffect(() => {
    const previousNewest = lastSeenNewestRef.current
    const newest = logs[0]?.timestamp ?? null
    lastSeenNewestRef.current = newest
    let delta = 0
    if (previousNewest !== null) {
      while (delta < logs.length && logs[delta].timestamp > previousNewest) delta++
    }

    if (!filters.autoRefresh || delta <= 0) return

    if (filters.autoScroll && filters.viewMode === "list") {
      if (scrollRef.current) scrollRef.current.scrollTop = 0
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
          setViewMode("list")
          setFocusedIndex(-1)
          requestAnimationFrame(() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = 0
            }
          })
        },
      },
    })
  }, [
    logs,
    filters.autoRefresh,
    filters.autoScroll,
    filters.viewMode,
    setViewMode,
    setFocusedIndex,
    t,
  ])

  // Detail-panel navigation — steps the selection through the whole filtered
  // list, and moves the keyboard cursor with it.
  const selectedLogId = filters.selectedLog?.id ?? null
  const selectedIndex = useMemo(() => {
    if (!selectedLogId) return -1
    return filteredLogs.findIndex((log) => log.id === selectedLogId)
  }, [filteredLogs, selectedLogId])

  const handleNavigateDetail = useCallback(
    (delta: -1 | 1) => {
      if (selectedIndex < 0) return
      const nextIndex = selectedIndex + delta
      const next = filteredLogs[nextIndex]
      if (!next) return
      setSelectedLog(next)
      setFocusedIndex(nextIndex)
    },
    [filteredLogs, selectedIndex, setSelectedLog, setFocusedIndex]
  )

  /** A related entry becomes the selection, and the cursor follows it into
   * the list when the entry is in it (it may be filtered out by level). */
  const handleSelectRelated = useCallback(
    (log: StructuredLogEntry) => {
      setSelectedLog(log)
      setFocusedIndex(filteredLogs.findIndex((entry) => entry.id === log.id))
    },
    [filteredLogs, setSelectedLog, setFocusedIndex]
  )

  const agentTraceWindow = useMemo(
    () => agentTraceWindowForRange(filters.timeRange, customTimeRange),
    [filters.timeRange, customTimeRange]
  )

  const resizableLayout = useResizableLayout("cognia-logs-panel-split")

  const band = selectedTransportHealth ? (
    <TransportHealthDetail
      health={selectedTransportHealth}
      history={selectedTransportHistory}
      // Closing the band closes the band. It used to drop the transport
      // filter too, so reading a tile undid the "View diagnostics" it led to.
      onClose={() => setSelectedTransportHealthName(null)}
      onViewDiagnostics={() => {
        handleDiagnosticTransportFilterChange(selectedTransportHealth.transport)
        handleSourceFilterChange("internal")
      }}
    />
  ) : filters.selectedNativeLogging ? (
    <NativeLoggingDetail
      nativeLogging={nativeLogging}
      onClose={() => setSelectedNativeLogging(false)}
    />
  ) : filters.moduleFilter === AGENT_TRACE_MODULE ? (
    // Agent-trace stats while the list is scoped to spans, over the window
    // that covers the panel's own time range.
    <AgentTraceStatsBar window={agentTraceWindow} className="border-b px-3 py-2" />
  ) : null

  return (
    <div
      ref={rootRef}
      // `border-b` only: every host frames the panel's top edge already (the
      // workspace header rule, the settings card), and `border-y` drew a
      // second line right under it.
      className={cn("flex h-full flex-col border-b bg-background", className)}
      style={maxHeight ? { maxHeight } : undefined}
      data-testid="log-panel"
    >
      <LogPanelToolbar
        viewMode={filters.viewMode}
        setViewMode={setViewMode}
        traceViewAvailable={traceViewAvailable}
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
        stats={facetStats}
        presets={filters.presets}
        activePresetId={filters.activePresetId}
        handlePresetChange={handlePresetChange}
        saveCurrentPreset={filters.saveCurrentPreset}
        removeActivePreset={filters.removeActivePreset}
        EMPTY_PRESET_VALUE={filters.EMPTY_PRESET_VALUE}
        traceFocusId={filters.traceFocusId}
        setTraceFocusId={handleTraceFocusChange}
        autoRefresh={filters.autoRefresh}
        setAutoRefresh={filters.setAutoRefresh}
        refresh={handleRefresh}
        onExport={handleExport}
        clearLogs={handleClearRequest}
        showDetailPanel={filters.showDetailPanel}
        setShowDetailPanel={setShowDetailPanel}
        canShowDetail={Boolean(filters.selectedLog) && filters.viewMode === "list"}
        onClearAllFilters={handleClearFacets}
        autoScroll={filters.autoScroll}
        setAutoScroll={filters.setAutoScroll}
        scrollToTop={scrollToTop}
        scrollToBottom={scrollToBottom}
        scrollActionsAvailable={filters.viewMode === "list" && filteredLogs.length > 0}
        autoScrollAvailable={filters.autoRefresh && filters.viewMode === "list"}
        bookmarkFilterActive={filters.bookmarkFilterActive}
        setBookmarkFilterActive={setBookmarkFilterActive}
        bookmarkedCount={facetStats.bookmarked}
        showAdvancedFilters={filters.showAdvancedFilters}
        setShowAdvancedFilters={filters.setShowAdvancedFilters}
        showShortcutsDialog={filters.showShortcutsDialog}
        setShowShortcutsDialog={setShowShortcutsDialog}
        searchHistory={filters.searchHistory}
        addSearchHistory={filters.addSearchHistory}
        removeSearchHistoryItem={filters.removeSearchHistoryItem}
        clearSearchHistory={filters.clearSearchHistory}
        diagnosticTransportFilter={filters.diagnosticTransportFilter}
        setDiagnosticTransportFilter={handleDiagnosticTransportFilterChange}
        customTimeRange={customTimeRange}
        setCustomTimeRange={handleCustomTimeRangeChange}
        density={filters.density}
        setDensity={filters.setDensity}
        healthSlot={
          showStats ? (
            <TransportHealthSummary
              healthByTransport={healthByTransport}
              nativeLogging={nativeLogging}
              onTransportClick={openTransportBand}
              onNativeLoggingClick={openNativeBand}
            />
          ) : null
        }
        statsSlot={
          showStats ? (
            <LogPanelStatsBar
              logRate={logRate}
              autoRefresh={filters.autoRefresh}
              windowCapped={windowCapped}
              windowSize={LOG_WINDOW_SIZE}
            />
          ) : null
        }
      />

      <AlertDialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("panel.clearConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("panel.clearConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("panel.clearConfirmCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleClearConfirm}>
              {t("panel.clearConfirmConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {band ? <div data-testid="log-panel-band">{band}</div> : null}

      {/* Main content area with optional detail panel */}
      <MainContent
        showTimeline={showTimeline}
        viewMode={filters.viewMode}
        filteredLogs={filteredLogs}
        facetBaseLogs={facetBaseLogs}
        customTimeRange={customTimeRange}
        handleCustomTimeRangeChange={handleCustomTimeRangeChange}
        logRate={logRate}
        nativeLogging={nativeLogging}
        onDashboardSearch={handleDashboardSearch}
        onDashboardModule={handleDashboardModule}
        onDashboardLevel={handleDashboardLevel}
        onTraceViewSelect={handleTraceViewSelect}
        filters={filters}
        handleFocusTrace={handleFocusTrace}
        handleFocusSession={handleFocusSession}
        emptyStateActiveFilterLabels={emptyStateActiveFilterLabels}
        windowCapped={windowCapped}
        handleClearAllFilters={handleClearAllFilters}
        isLoading={isLoading}
        error={error}
        refresh={handleRefresh}
        scrollRef={scrollRef}
        containerRef={containerRef}
        sideDetail={sideDetail}
        narrow={narrow}
        relatedLogs={relatedLogs}
        onSelectRelated={handleSelectRelated}
        resizableLayout={resizableLayout}
        density={filters.density}
        selectedIndex={selectedIndex}
        onNavigateDetail={handleNavigateDetail}
        onOpenTrace={onOpenTrace}
        t={t}
      />
    </div>
  )
}

interface MainContentProps {
  showTimeline: boolean
  viewMode: LogPanelFilterState["viewMode"]
  filteredLogs: StructuredLogEntry[]
  facetBaseLogs: StructuredLogEntry[]
  customTimeRange: { start: Date; end: Date } | null
  handleCustomTimeRangeChange: (range: { start: Date; end: Date } | null) => void
  logRate: number
  nativeLogging: UseTransportHealthResult["nativeLogging"]
  onDashboardSearch: (query: string) => void
  onDashboardModule: (moduleName: string) => void
  onDashboardLevel: (level: LogLevel) => void
  onTraceViewSelect: (traceId: string) => void
  filters: LogPanelFilterState
  handleFocusTrace: (traceId: string, log: StructuredLogEntry) => void
  handleFocusSession: (sessionId: string, log: StructuredLogEntry) => void
  emptyStateActiveFilterLabels: string[]
  windowCapped: boolean
  handleClearAllFilters: () => void
  isLoading: boolean
  error: Error | null
  refresh: () => void
  scrollRef: React.RefObject<HTMLDivElement | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  sideDetail: boolean
  narrow: boolean
  relatedLogs: StructuredLogEntry[]
  onSelectRelated: (log: StructuredLogEntry) => void
  resizableLayout: UseResizableLayoutResult
  density: LogPanelFilterState["density"]
  selectedIndex: number
  onNavigateDetail: (delta: -1 | 1) => void
  onOpenTrace?: (traceId: string) => void
  t: ReturnType<typeof useTranslations>
}

function MainContent({
  showTimeline,
  viewMode,
  filteredLogs,
  facetBaseLogs,
  customTimeRange,
  handleCustomTimeRangeChange,
  logRate,
  nativeLogging,
  onDashboardSearch,
  onDashboardModule,
  onDashboardLevel,
  onTraceViewSelect,
  filters,
  handleFocusTrace,
  handleFocusSession,
  emptyStateActiveFilterLabels,
  windowCapped,
  handleClearAllFilters,
  isLoading,
  error,
  refresh,
  scrollRef,
  containerRef,
  sideDetail,
  narrow,
  relatedLogs,
  onSelectRelated,
  resizableLayout,
  density,
  selectedIndex,
  onNavigateDetail,
  onOpenTrace,
  t,
}: MainContentProps) {
  // The detail pane belongs to the list. On the dashboard or the trace view
  // it used to stay docked, showing an entry from a list that was not on
  // screen and squeezing the charts into 70% of the width.
  const detailVisible =
    viewMode === "list" && filters.showDetailPanel && Boolean(filters.selectedLog)
  const detailOpen = detailVisible && sideDetail
  const selectedLogId = detailVisible && filters.selectedLog ? filters.selectedLog.id : null

  // A row click opens the entry, the way a row click does on every other
  // channel of this workspace (Diagnostics, Incidents, Traces). It used to
  // expand the row in place — the same data, stack and source the detail pane
  // renders, at a third of its width — and the pane was reachable only through
  // a hover-revealed icon. The chevron still expands in place, for a peek.
  const { handleSelectLog, setFocusedIndex } = filters
  const handleActivateRow = useCallback(
    (log: StructuredLogEntry, index: number) => {
      setFocusedIndex(index)
      handleSelectLog(log)
    },
    [handleSelectLog, setFocusedIndex]
  )

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
            logs={facetBaseLogs}
            logRate={logRate}
            nativeLogging={nativeLogging}
            onSearchFilter={onDashboardSearch}
            onModuleFilter={onDashboardModule}
            onLevelFilter={onDashboardLevel}
          />
        </ScrollArea>
      ) : viewMode === "trace" ? (
        <ScrollArea className="flex-1">
          <LogTraceView
            filteredLogs={filteredLogs}
            onSelectTrace={onTraceViewSelect}
            onOpenTrace={onOpenTrace}
          />
        </ScrollArea>
      ) : (
        <VirtualizedLogList
          scrollRef={scrollRef}
          containerRef={containerRef}
          isLoading={isLoading}
          error={error}
          filteredLogs={filteredLogs}
          expandedIds={filters.expandedIds}
          toggleExpanded={filters.toggleExpanded}
          searchQuery={filters.searchQuery}
          useRegex={filters.useRegex}
          bookmarkedIds={filters.bookmarkedIds}
          toggleBookmark={filters.toggleBookmark}
          handleSelectLog={filters.handleSelectLog}
          onActivateRow={handleActivateRow}
          focusedIndex={filters.focusedIndex}
          onFocusRow={setFocusedIndex}
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
            windowCappedCount: windowCapped ? LOG_WINDOW_SIZE : undefined,
          }}
        />
      )}
    </div>
  )

  const selected = filters.selectedLog
  // "Open in Traces" needs a trace the explorer has: an agent-trace span in
  // it. The entry itself is usually a plain log line written during the run,
  // so the spans among its neighbours count as well.
  const traceHasSpans =
    Boolean(selected?.traceId) &&
    (selected?.module === AGENT_TRACE_MODULE ||
      relatedLogs.some((log) => log.module === AGENT_TRACE_MODULE))
  const renderDetailPanel = (className?: string) =>
    selected ? (
      <LogDetailPanel
        log={selected}
        relatedLogs={relatedLogs}
        isBookmarked={filters.bookmarkedIds.has(selected.id)}
        onClose={() => filters.setShowDetailPanel(false)}
        onToggleBookmark={filters.toggleBookmark}
        onSelectRelated={onSelectRelated}
        onNavigate={selectedIndex >= 0 ? onNavigateDetail : undefined}
        navPosition={
          selectedIndex >= 0 ? { index: selectedIndex + 1, total: filteredLogs.length } : undefined
        }
        onFocusTrace={
          selected.traceId && filters.traceFocusId !== selected.traceId
            ? () => handleFocusTrace(selected.traceId!, selected)
            : undefined
        }
        onFocusSession={
          selected.sessionId && filters.sessionFilter.trim() !== selected.sessionId
            ? () => handleFocusSession(selected.sessionId!, selected)
            : undefined
        }
        onOpenTrace={
          onOpenTrace && selected.traceId && traceHasSpans
            ? () => onOpenTrace(selected.traceId!)
            : undefined
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

      {/* A panel too narrow for two panes shows the detail as a sheet: from
          the right on a tablet or a narrow window, like the Diagnostics and
          Incidents drawers on the neighbouring channels, and full-height from
          the bottom on a phone. */}
      {!sideDetail && (
        <Sheet
          open={detailVisible}
          onOpenChange={(open) => {
            if (!open) filters.setShowDetailPanel(false)
          }}
        >
          <SheetContent
            side={narrow ? "bottom" : "right"}
            // The detail pane draws its own close button in its header; the
            // sheet's would sit on top of the pane's navigation and bookmark.
            showCloseButton={false}
            // Land focus on the sheet itself rather than its first control —
            // that was the "previous entry" arrow, whose tooltip then popped
            // over the header on every open.
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              ;(event.currentTarget as HTMLElement | null)?.focus()
            }}
            className={cn(
              "flex flex-col gap-0 p-0",
              narrow ? "h-dvh max-h-dvh" : "w-[min(92vw,560px)] sm:max-w-none"
            )}
            data-testid="log-detail-sheet"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{t("panel.logDetails")}</SheetTitle>
              <SheetDescription>{t("panel.logDetailsDescription")}</SheetDescription>
            </SheetHeader>
            {renderDetailPanel("flex-1 min-h-0 border-0")}
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}

export default LogPanel
