"use client"

/**
 * useLogPanelUrlSync
 *
 * Bidirectional sync between the log panel filter state and the URL query
 * string. Reads the query string once on mount (silently ignores malformed
 * values), then mirrors subsequent state changes into the URL via
 * `window.history.replaceState` — chosen over `router.replace` so the static
 * `output: "export"` build does not re-evaluate the route on every keystroke.
 *
 * The write pass only owns the keys in `OWNED_PARAMS`; anything else already in
 * the query string is carried through untouched, so a host page can keep its
 * own params alongside the panel's.
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

/**
 * Every query key this hook owns. The write pass rebuilds them from filter
 * state, so it must DELETE exactly these from the live query string rather
 * than starting from an empty `URLSearchParams` — the panel is embedded in
 * hosts that own page-level params of their own (`/logs` carries `channel`
 * and `traceId` for its Traces channel), and rebuilding from empty silently
 * dropped them on the first keystroke.
 */
const OWNED_PARAMS = [
  "q",
  "re",
  "level",
  "module",
  "src",
  "session",
  "t",
  "from",
  "to",
  "trace",
  "dx",
  "bm",
  "hsev",
  "view",
  "page",
  "size",
  "detail",
  "sel",
  "density",
] as const

export function useLogPanelUrlSync(filters: LogPanelFilterState): void {
  const searchParams = useSearchParams()
  const hydratedRef = useRef(false)

  // Mount-time hydration. Done in a ref guard so toggling filter values later
  // never re-applies stale URL values.
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true

    // `window.location.search` is the authority here, not `useSearchParams()`.
    // A host that seeds the panel by writing params and remounting it (the
    // `/logs` Traces → Logs jump) uses `history.replaceState`; the router's
    // snapshot may not have caught up by the time this effect runs, and the
    // live URL always has. `useSearchParams()` is still read — it keeps this
    // hook's dynamic-rendering behaviour, and it is the fallback for any
    // environment without `window`.
    const params =
      typeof window !== "undefined" ? new URLSearchParams(window.location.search) : searchParams
    if (!params) return

    const q = params.get("q")
    if (q !== null) filters.setSearchQuery(q)

    if (params.get("re") === "1") filters.setUseRegex(true)

    const level = params.get("level")
    if (level && VALID_LEVELS.has(level as LogLevel | "all")) {
      filters.setLevelFilter(level as LogLevel | "all")
    }

    const moduleParam = params.get("module")
    if (moduleParam) filters.setModuleFilter(moduleParam)

    const src = params.get("src")
    if (src && VALID_SOURCES.has(src as PanelSource | "all")) {
      filters.setSourceFilter(src as PanelSource | "all")
    }

    const session = params.get("session")
    if (session) filters.setSessionFilter(session)

    const t = params.get("t")
    if (t && VALID_TIME_RANGES.has(t as PresetTimeRange)) {
      filters.setTimeRange(t as PresetTimeRange)
    }

    const from = params.get("from")
    const to = params.get("to")
    if (from && to) {
      const fromMs = Number(from)
      const toMs = Number(to)
      if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs) {
        filters.setCustomTimeRange({ start: new Date(fromMs), end: new Date(toMs) })
      }
    }

    const trace = params.get("trace")
    if (trace) filters.setTraceFocusId(trace)

    const dx = params.get("dx")
    if (dx) filters.setDiagnosticTransportFilter(dx)

    if (params.get("bm") === "1") filters.setBookmarkFilterActive(true)
    if (params.get("hsev") === "1") filters.setHighSeverityOnly(true)

    const view = params.get("view")
    if (view && VALID_VIEW_MODES.has(view as ViewMode)) {
      filters.setViewMode(view as ViewMode)
    }

    const page = params.get("page")
    if (page) {
      const n = Number(page)
      if (Number.isFinite(n) && n >= 1) filters.setCurrentPage(Math.floor(n))
    }

    const size = params.get("size")
    if (size) {
      const n = Number(size)
      if (Number.isFinite(n) && n >= 1 && n <= 1000) filters.setPageSize(Math.floor(n))
    }

    if (params.get("detail") === "1") filters.setShowDetailPanel(true)

    const density = params.get("density")
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

    // Seed from the live query string and clear only our own keys, so any
    // host-owned param survives a filter change.
    const params = new URLSearchParams(window.location.search)
    for (const key of OWNED_PARAMS) params.delete(key)
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
