/**
 * useLogPanelFilters Hook
 *
 * Extracted from log-panel.tsx — manages all filter state for the log panel.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react"
import {
  LOG_FILTER_PRESETS_STORAGE_KEY,
  createLogFilterPreset,
  loadLogFilterPresets,
  serializeLogFilterPresets,
} from "@cognia/logging/filter-presets"
import type {
  LogFilterPreset,
  LogFilterPresetFilters,
  PresetTimeRange,
  StructuredLogEntry,
  LogLevel,
  ViewMode,
  PanelSource,
  Density,
  LogPanelFilterState,
  UseLogPanelFiltersOptions,
} from "@/types/logging"

export type {
  ViewMode,
  PanelSource,
  Density,
  LogPanelFilterState,
  UseLogPanelFiltersOptions,
} from "@/types/logging"

const BOOKMARKS_STORAGE_KEY = "cognia-log-bookmarks"
const DENSITY_STORAGE_KEY = "cognia-log-density"
const AUTO_REFRESH_STORAGE_KEY = "cognia-log-auto-refresh"
const VALID_DENSITIES: Density[] = ["compact", "comfortable", "spacious"]
const VALID_SOURCES = new Set<PanelSource | "all">([
  "all",
  "frontend",
  "tauri",
  "mcp",
  "plugin",
  "internal",
])
const EMPTY_PRESET_VALUE = "__none__"

/**
 * The live-follow key for one embed. The unscoped key stays the `/logs`
 * panel's so its stored preference survives; every other embed gets a key of
 * its own and can no longer flip `/logs` (or be flipped by it).
 */
export function autoRefreshStorageKey(scope?: string): string {
  const trimmed = scope?.trim()
  return trimmed ? `${AUTO_REFRESH_STORAGE_KEY}:${trimmed}` : AUTO_REFRESH_STORAGE_KEY
}

/** The facets a preset captures, normalised to the shape the panel holds them in. */
interface PresetFacets {
  levelFilter: LogLevel | "all"
  moduleFilter: string
  timeRange: PresetTimeRange
  searchQuery: string
  useRegex: boolean
  sourceFilter: PanelSource | "all"
  sessionFilter: string
  customTimeRange: { start: number; end: number } | null
  traceFocusId: string | null
  diagnosticTransportFilter: string | null
}

/**
 * Read a stored preset defensively. The v1 validator only checks the original
 * six keys, so the later optional ones arrive unchecked from localStorage — a
 * malformed value falls back to the facet's default instead of reaching state.
 * `defaultSource` is the embed's own default (Settings → MCP opens on `mcp`),
 * which is what "this preset did not pin a source" restores.
 */
export function resolvePresetFacets(
  filters: LogFilterPresetFilters,
  defaultSource: PanelSource | "all"
): PresetFacets {
  // Legacy: before the Error tab carried fatal on its own, "errors only" was
  // `levelFilter: "all"` plus this flag. Such a preset now opens the Error tab.
  const levelFilter =
    filters.levelFilter === "all" && filters.highSeverityOnly ? "error" : filters.levelFilter
  const source = filters.sourceFilter
  const range = filters.customTimeRange
  const validRange =
    range &&
    typeof range === "object" &&
    Number.isFinite(range.start) &&
    Number.isFinite(range.end) &&
    range.start < range.end
      ? { start: range.start, end: range.end }
      : null
  return {
    levelFilter,
    moduleFilter: filters.moduleFilter,
    timeRange: validRange ? "all" : filters.timeRange,
    searchQuery: filters.searchQuery,
    useRegex: filters.useRegex,
    sourceFilter:
      typeof source === "string" && VALID_SOURCES.has(source as PanelSource | "all")
        ? (source as PanelSource | "all")
        : defaultSource,
    sessionFilter: typeof filters.sessionFilter === "string" ? filters.sessionFilter : "",
    customTimeRange: validRange,
    traceFocusId:
      typeof filters.traceFocusId === "string" && filters.traceFocusId
        ? filters.traceFocusId
        : null,
    diagnosticTransportFilter:
      typeof filters.diagnosticTransportFilter === "string" && filters.diagnosticTransportFilter
        ? filters.diagnosticTransportFilter
        : null,
  }
}

function facetsEqual(a: PresetFacets, b: PresetFacets): boolean {
  return (
    a.levelFilter === b.levelFilter &&
    a.moduleFilter === b.moduleFilter &&
    a.timeRange === b.timeRange &&
    a.searchQuery === b.searchQuery &&
    a.useRegex === b.useRegex &&
    a.sourceFilter === b.sourceFilter &&
    a.sessionFilter.trim() === b.sessionFilter.trim() &&
    (a.customTimeRange?.start ?? null) === (b.customTimeRange?.start ?? null) &&
    (a.customTimeRange?.end ?? null) === (b.customTimeRange?.end ?? null) &&
    a.traceFocusId === b.traceFocusId &&
    a.diagnosticTransportFilter === b.diagnosticTransportFilter
  )
}

export function useLogPanelFilters(options: UseLogPanelFiltersOptions = {}): LogPanelFilterState {
  const {
    defaultAutoRefresh = false,
    sources,
    density: controlledDensity,
    onDensityChange,
    storageScope,
  } = options
  const autoRefreshKey = autoRefreshStorageKey(storageScope)
  // Controlled only when the host can actually receive the write — a `density`
  // with no `onDensityChange` would render a control that moves nothing.
  const densityControlled = controlledDensity !== undefined && onDensityChange !== undefined

  // Persisted across sessions (like density) — reopening the panel keeps the
  // user's live-follow preference instead of resetting to off. Per embed: see
  // `autoRefreshStorageKey`.
  const [autoRefresh, setAutoRefreshState] = useState(() => {
    if (typeof window === "undefined") return defaultAutoRefresh
    try {
      const stored = window.localStorage.getItem(autoRefreshKey)
      return stored === null ? defaultAutoRefresh : stored === "1"
    } catch {
      return defaultAutoRefresh
    }
  })
  const setAutoRefresh = useCallback(
    (next: boolean) => {
      setAutoRefreshState(next)
      try {
        window.localStorage.setItem(autoRefreshKey, next ? "1" : "0")
      } catch {
        // ignore storage quota / private-mode errors
      }
    },
    [autoRefreshKey]
  )
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all")
  const [moduleFilter, setModuleFilter] = useState<string>("all")
  const defaultSourceFilter: PanelSource | "all" =
    sources && sources.length === 1 ? sources[0] : "all"
  const [sourceFilter, setSourceFilter] = useState<PanelSource | "all">(defaultSourceFilter)
  const [sessionFilter, setSessionFilter] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [useRegex, setUseRegex] = useState(false)
  const [timeRange, setTimeRange] = useState<PresetTimeRange>("all")
  const [customTimeRange, setCustomTimeRange] = useState<{ start: Date; end: Date } | null>(null)
  const [traceFocusId, setTraceFocusId] = useState<string | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>("list")
  const [selectedLog, setSelectedLog] = useState<StructuredLogEntry | null>(null)
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [selectedTransportHealthName, setSelectedTransportHealthName] = useState<string | null>(
    null
  )
  const [selectedNativeLogging, setSelectedNativeLogging] = useState(false)
  const [diagnosticTransportFilter, setDiagnosticTransportFilter] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [uncontrolledDensity, setUncontrolledDensity] = useState<Density>(() => {
    if (typeof window === "undefined") return "comfortable"
    try {
      const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY)
      return stored && (VALID_DENSITIES as string[]).includes(stored)
        ? (stored as Density)
        : "comfortable"
    } catch {
      return "comfortable"
    }
  })
  const density = densityControlled ? controlledDensity : uncontrolledDensity
  const setDensity = useCallback(
    (next: Density) => {
      if (densityControlled) {
        onDensityChange(next)
        return
      }
      setUncontrolledDensity(next)
      try {
        window.localStorage.setItem(DENSITY_STORAGE_KEY, next)
      } catch {
        // ignore storage quota / private-mode errors
      }
    },
    [densityControlled, onDensityChange]
  )

  const [bookmarkFilterActive, setBookmarkFilterActive] = useState(false)
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)

  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    if (typeof window === "undefined") return []
    try {
      const stored = localStorage.getItem("log-panel-search-history")
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [presets, setPresets] = useState<LogFilterPreset[]>(() => {
    if (typeof window === "undefined") return []
    return loadLogFilterPresets(localStorage.getItem(LOG_FILTER_PRESETS_STORAGE_KEY))
  })
  const [appliedPresetId, setAppliedPresetId] = useState<string>(EMPTY_PRESET_VALUE)

  const currentFacets = useMemo<PresetFacets>(
    () => ({
      levelFilter,
      moduleFilter,
      timeRange,
      searchQuery,
      useRegex,
      sourceFilter,
      sessionFilter,
      customTimeRange: customTimeRange
        ? { start: customTimeRange.start.getTime(), end: customTimeRange.end.getTime() }
        : null,
      traceFocusId,
      diagnosticTransportFilter,
    }),
    [
      levelFilter,
      moduleFilter,
      timeRange,
      searchQuery,
      useRegex,
      sourceFilter,
      sessionFilter,
      customTimeRange,
      traceFocusId,
      diagnosticTransportFilter,
    ]
  )

  // The picker names a preset only while the filters still are that preset.
  // Derived during render rather than cleared from an effect: every setter
  // that diverges from it would otherwise need to remember to reset it.
  const activePresetId = useMemo(() => {
    if (appliedPresetId === EMPTY_PRESET_VALUE) return EMPTY_PRESET_VALUE
    const preset = presets.find((item) => item.id === appliedPresetId)
    if (!preset) return EMPTY_PRESET_VALUE
    return facetsEqual(resolvePresetFacets(preset.filters, defaultSourceFilter), currentFacets)
      ? appliedPresetId
      : EMPTY_PRESET_VALUE
  }, [appliedPresetId, presets, currentFacets, defaultSourceFilter])

  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set()
    try {
      const stored = localStorage.getItem(BOOKMARKS_STORAGE_KEY)
      return stored ? new Set(JSON.parse(stored)) : new Set()
    } catch {
      return new Set()
    }
  })

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const toggleBookmark = useCallback((id: string) => {
    setBookmarkedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      try {
        localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // Ignore storage errors
      }
      return next
    })
  }, [])

  const persistPresets = useCallback((next: LogFilterPreset[]) => {
    try {
      localStorage.setItem(LOG_FILTER_PRESETS_STORAGE_KEY, serializeLogFilterPresets(next))
    } catch {
      // Ignore storage errors
    }
  }, [])

  const saveCurrentPreset = useCallback(
    (name?: string) => {
      const trimmed = name?.trim() ?? ""
      // The fallback is only reached by programmatic callers; the toolbar always
      // supplies a (translated, editable) name.
      const presetName = trimmed.length > 0 ? trimmed : `#${presets.length + 1}`
      // Every facet the panel narrows by, not just the original five: a preset
      // saved on "source = MCP, last session" used to come back as "all
      // sources, every session" and silently show something else.
      const presetFilters: LogFilterPresetFilters = {
        levelFilter: currentFacets.levelFilter,
        moduleFilter: currentFacets.moduleFilter,
        timeRange: currentFacets.timeRange,
        searchQuery: currentFacets.searchQuery,
        useRegex: currentFacets.useRegex,
        // Kept for the v1 validator; see the type's note.
        highSeverityOnly: currentFacets.levelFilter === "error",
        sourceFilter: currentFacets.sourceFilter,
        sessionFilter: currentFacets.sessionFilter.trim(),
        customTimeRange: currentFacets.customTimeRange,
        traceFocusId: currentFacets.traceFocusId,
        diagnosticTransportFilter: currentFacets.diagnosticTransportFilter,
      }
      const preset = createLogFilterPreset(presetName, presetFilters)
      const next = [...presets, preset]
      setPresets(next)
      setAppliedPresetId(preset.id)
      persistPresets(next)
    },
    [presets, currentFacets, persistPresets]
  )

  const applyPreset = useCallback(
    (preset: LogFilterPreset) => {
      const facets = resolvePresetFacets(preset.filters, defaultSourceFilter)
      setLevelFilter(facets.levelFilter)
      setModuleFilter(facets.moduleFilter)
      setTimeRange(facets.timeRange)
      setSearchQuery(facets.searchQuery)
      setUseRegex(facets.useRegex)
      setSourceFilter(facets.sourceFilter)
      setSessionFilter(facets.sessionFilter)
      setCustomTimeRange(
        facets.customTimeRange
          ? {
              start: new Date(facets.customTimeRange.start),
              end: new Date(facets.customTimeRange.end),
            }
          : null
      )
      setTraceFocusId(facets.traceFocusId)
      setDiagnosticTransportFilter(facets.diagnosticTransportFilter)
      // A preset names a filter set, not the bookmark view; leaving the
      // bookmark tab on would show "Errors last hour" ∩ bookmarks.
      setBookmarkFilterActive(false)
      setAppliedPresetId(preset.id)
    },
    [defaultSourceFilter]
  )

  const removeActivePreset = useCallback(() => {
    if (activePresetId === EMPTY_PRESET_VALUE) return
    const next = presets.filter((preset) => preset.id !== activePresetId)
    setPresets(next)
    setAppliedPresetId(EMPTY_PRESET_VALUE)
    persistPresets(next)
  }, [activePresetId, presets, persistPresets])

  const handlePresetChange = useCallback(
    (presetId: string) => {
      if (presetId === EMPTY_PRESET_VALUE) {
        setAppliedPresetId(EMPTY_PRESET_VALUE)
        return
      }
      const preset = presets.find((item) => item.id === presetId)
      if (preset) {
        applyPreset(preset)
      }
    },
    [presets, applyPreset]
  )

  const handleSelectLog = useCallback((log: StructuredLogEntry) => {
    setSelectedLog(log)
    setShowDetailPanel(true)
  }, [])

  // Narrowing to a trace or a session leaves the detail pane as it was: the
  // pivot is usually made from the detail pane itself, and closing it there
  // threw away the entry the user was reading the moment they asked for its
  // neighbours. Trace focus used to force the pane open as well, so the row
  // crosshair (meant as "show me just this trace") also covered a third of the
  // list it had just narrowed; the two pivots now behave the same.
  const handleFocusTrace = useCallback((traceId: string, log: StructuredLogEntry) => {
    setTraceFocusId(traceId)
    setModuleFilter("all")
    setSelectedLog(log)
  }, [])

  const handleFocusSession = useCallback((sessionId: string, log: StructuredLogEntry) => {
    setSessionFilter(sessionId)
    setSelectedLog(log)
  }, [])

  const addSearchHistory = useCallback((query: string) => {
    if (!query.trim()) return
    setSearchHistory((prev) => {
      const next = [query, ...prev.filter((q) => q !== query)].slice(0, 5)
      try {
        localStorage.setItem("log-panel-search-history", JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const removeSearchHistoryItem = useCallback((query: string) => {
    setSearchHistory((prev) => {
      const next = prev.filter((q) => q !== query)
      try {
        localStorage.setItem("log-panel-search-history", JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const clearSearchHistory = useCallback(() => {
    setSearchHistory([])
    try {
      localStorage.removeItem("log-panel-search-history")
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (searchQuery.trim()) {
      searchDebounceRef.current = setTimeout(() => {
        addSearchHistory(searchQuery.trim())
      }, 2000)
    }
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [searchQuery, addSearchHistory])

  return useMemo(
    () => ({
      autoRefresh,
      levelFilter,
      moduleFilter,
      sourceFilter,
      sessionFilter,
      searchQuery,
      useRegex,
      timeRange,
      customTimeRange,
      traceFocusId,
      autoScroll,
      viewMode,
      selectedLog,
      showDetailPanel,
      selectedTransportHealthName,
      selectedNativeLogging,
      diagnosticTransportFilter,
      expandedIds,
      focusedIndex,
      density,
      presets,
      activePresetId,
      bookmarkedIds,
      bookmarkFilterActive,
      showAdvancedFilters,
      showShortcutsDialog,
      searchHistory,

      setAutoRefresh,
      setLevelFilter,
      setModuleFilter,
      setSourceFilter,
      setSessionFilter,
      setSearchQuery,
      setUseRegex,
      setTimeRange,
      setCustomTimeRange,
      setTraceFocusId,
      setAutoScroll,
      setViewMode,
      setSelectedLog,
      setShowDetailPanel,
      setSelectedTransportHealthName,
      setSelectedNativeLogging,
      setDiagnosticTransportFilter,
      setFocusedIndex,
      setDensity,
      setBookmarkFilterActive,
      setShowAdvancedFilters,
      setShowShortcutsDialog,

      toggleExpanded,
      toggleBookmark,
      saveCurrentPreset,
      applyPreset,
      handlePresetChange,
      removeActivePreset,
      handleSelectLog,
      handleFocusTrace,
      handleFocusSession,
      addSearchHistory,
      removeSearchHistoryItem,
      clearSearchHistory,

      EMPTY_PRESET_VALUE,
    }),
    [
      autoRefresh,
      setAutoRefresh,
      levelFilter,
      moduleFilter,
      sourceFilter,
      sessionFilter,
      searchQuery,
      useRegex,
      timeRange,
      customTimeRange,
      traceFocusId,
      autoScroll,
      viewMode,
      selectedLog,
      showDetailPanel,
      selectedTransportHealthName,
      selectedNativeLogging,
      diagnosticTransportFilter,
      expandedIds,
      focusedIndex,
      density,
      setDensity,
      presets,
      activePresetId,
      bookmarkedIds,
      bookmarkFilterActive,
      showAdvancedFilters,
      showShortcutsDialog,
      searchHistory,
      toggleExpanded,
      toggleBookmark,
      saveCurrentPreset,
      applyPreset,
      handlePresetChange,
      removeActivePreset,
      handleSelectLog,
      handleFocusTrace,
      handleFocusSession,
      addSearchHistory,
      removeSearchHistoryItem,
      clearSearchHistory,
    ]
  )
}
