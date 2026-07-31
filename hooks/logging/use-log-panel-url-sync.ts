"use client"

/**
 * useLogPanelUrlSync
 *
 * Bidirectional sync between the log panel filter state and the URL query
 * string. Reads `useSearchParams()` once on mount (silently ignores malformed
 * values), then mirrors subsequent state changes into the URL via
 * `window.history.replaceState` — chosen over `router.replace` so the static
 * `output: "export"` build does not re-evaluate the route on every keystroke.
 */

import { useEffect, useRef } from "react"
import { useSearchParams } from "next/navigation"
import type { Density, LogPanelFilterState, ViewMode, PanelSource } from "./use-log-panel-filters"
import type { LogLevel } from "@cognia/logging"
import type { PresetTimeRange } from "@cognia/logging/filter-presets"

const VALID_LEVELS = new Set<LogLevel | "all">([
  "all",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
])
const VALID_TIME_RANGES = new Set<PresetTimeRange>(["all", "15m", "1h", "6h", "24h", "7d"])
const VALID_VIEW_MODES = new Set<ViewMode>(["list", "dashboard", "trace"])
const VALID_SOURCES = new Set<PanelSource | "all">([
  "all",
  "frontend",
  "tauri",
  "mcp",
  "plugin",
  "internal",
])
const VALID_DENSITIES = new Set<Density>(["compact", "comfortable", "spacious"])

const DEFAULT_PAGE_SIZE = 50

export function useLogPanelUrlSync(filters: LogPanelFilterState): void {
  const searchParams = useSearchParams()
  const hydratedRef = useRef(false)

  // Mount-time hydration. Done in a ref guard so toggling filter values later
  // never re-applies stale URL values.
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    if (!searchParams) return

    const q = searchParams.get("q")
    if (q !== null) filters.setSearchQuery(q)

    if (searchParams.get("re") === "1") filters.setUseRegex(true)

    const level = searchParams.get("level")
    if (level && VALID_LEVELS.has(level as LogLevel | "all")) {
      filters.setLevelFilter(level as LogLevel | "all")
    }

    const moduleParam = searchParams.get("module")
    if (moduleParam) filters.setModuleFilter(moduleParam)

    const src = searchParams.get("src")
    if (src && VALID_SOURCES.has(src as PanelSource | "all")) {
      filters.setSourceFilter(src as PanelSource | "all")
    }

    const session = searchParams.get("session")
    if (session) filters.setSessionFilter(session)

    const t = searchParams.get("t")
    if (t && VALID_TIME_RANGES.has(t as PresetTimeRange)) {
      filters.setTimeRange(t as PresetTimeRange)
    }

    const from = searchParams.get("from")
    const to = searchParams.get("to")
    if (from && to) {
      const fromMs = Number(from)
      const toMs = Number(to)
      if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs) {
        filters.setCustomTimeRange({ start: new Date(fromMs), end: new Date(toMs) })
      }
    }

    const trace = searchParams.get("trace")
    if (trace) filters.setTraceFocusId(trace)

    const dx = searchParams.get("dx")
    if (dx) filters.setDiagnosticTransportFilter(dx)

    if (searchParams.get("bm") === "1") filters.setBookmarkFilterActive(true)
    if (searchParams.get("hsev") === "1") filters.setHighSeverityOnly(true)

    const view = searchParams.get("view")
    if (view && VALID_VIEW_MODES.has(view as ViewMode)) {
      filters.setViewMode(view as ViewMode)
    }

    const page = searchParams.get("page")
    if (page) {
      const n = Number(page)
      if (Number.isFinite(n) && n >= 1) filters.setCurrentPage(Math.floor(n))
    }

    const size = searchParams.get("size")
    if (size) {
      const n = Number(size)
      if (Number.isFinite(n) && n >= 1 && n <= 1000) filters.setPageSize(Math.floor(n))
    }

    if (searchParams.get("detail") === "1") filters.setShowDetailPanel(true)

    const density = searchParams.get("density")
    if (density && VALID_DENSITIES.has(density as Density)) {
      filters.setDensity(density as Density)
    }
    // `sel` (selectedLog.id) is preserved on write so deep links round-trip
    // visually, but we can't rehydrate the StructuredLogEntry payload at mount
    // time (logs haven't loaded yet). The panel re-resolves it organically.
  }, [filters, searchParams])

  const lastUrlRef = useRef<string>("")
  useEffect(() => {
    if (!hydratedRef.current) return
    if (typeof window === "undefined") return

    const params = new URLSearchParams()
    if (filters.searchQuery) params.set("q", filters.searchQuery)
    if (filters.useRegex) params.set("re", "1")
    if (filters.levelFilter !== "all") params.set("level", filters.levelFilter)
    if (filters.moduleFilter !== "all") params.set("module", filters.moduleFilter)
    if (filters.sourceFilter !== "all") params.set("src", filters.sourceFilter)
    if (filters.sessionFilter.trim()) params.set("session", filters.sessionFilter.trim())
    if (filters.timeRange !== "all") params.set("t", filters.timeRange)
    if (filters.customTimeRange) {
      params.set("from", String(filters.customTimeRange.start.getTime()))
      params.set("to", String(filters.customTimeRange.end.getTime()))
    }
    if (filters.traceFocusId) params.set("trace", filters.traceFocusId)
    if (filters.diagnosticTransportFilter) params.set("dx", filters.diagnosticTransportFilter)
    if (filters.bookmarkFilterActive) params.set("bm", "1")
    if (filters.highSeverityOnly) params.set("hsev", "1")
    if (filters.viewMode !== "list") params.set("view", filters.viewMode)
    if (filters.currentPage > 1) params.set("page", String(filters.currentPage))
    if (filters.pageSize !== DEFAULT_PAGE_SIZE) params.set("size", String(filters.pageSize))
    if (filters.showDetailPanel) params.set("detail", "1")
    if (filters.selectedLog?.id) params.set("sel", filters.selectedLog.id)
    if (filters.density !== "comfortable") params.set("density", filters.density)

    const queryString = params.toString()
    const nextUrl = queryString
      ? `${window.location.pathname}?${queryString}`
      : window.location.pathname

    if (lastUrlRef.current === nextUrl) return
    lastUrlRef.current = nextUrl

    try {
      window.history.replaceState({}, "", nextUrl)
    } catch {
      // window.history may be unavailable in some sandboxed contexts
    }
  }, [
    filters.searchQuery,
    filters.useRegex,
    filters.levelFilter,
    filters.moduleFilter,
    filters.sourceFilter,
    filters.sessionFilter,
    filters.timeRange,
    filters.customTimeRange,
    filters.traceFocusId,
    filters.diagnosticTransportFilter,
    filters.bookmarkFilterActive,
    filters.highSeverityOnly,
    filters.viewMode,
    filters.currentPage,
    filters.pageSize,
    filters.showDetailPanel,
    filters.selectedLog,
    filters.density,
  ])
}
