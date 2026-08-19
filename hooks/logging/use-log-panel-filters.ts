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
const EMPTY_PRESET_VALUE = "__none__"

export function useLogPanelFilters(options: UseLogPanelFiltersOptions = {}): LogPanelFilterState {
  const {
    defaultAutoRefresh = false,
    sources,
    density: controlledDensity,
    onDensityChange,
  } = options
  // Controlled only when the host can actually receive the write — a `density`
  // with no `onDensityChange` would render a control that moves nothing.
  const densityControlled = controlledDensity !== undefined && onDensityChange !== undefined

  // Persisted across sessions (like density) — reopening the panel keeps the
  // user's live-follow preference instead of resetting to off.
  const [autoRefresh, setAutoRefreshState] = useState(() => {
    if (typeof window === "undefined") return defaultAutoRefresh
    try {
      const stored = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY)
      return stored === null ? defaultAutoRefresh : stored === "1"
    } catch {
      return defaultAutoRefresh
    }
  })
  const setAutoRefresh = useCallback((next: boolean) => {
    setAutoRefreshState(next)
    try {
      window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, next ? "1" : "0")
    } catch {
      // ignore storage quota / private-mode errors
    }
  }, [])
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all")
  const [moduleFilter, setModuleFilter] = useState<string>("all")
  const [sourceFilter, setSourceFilter] = useState<PanelSource | "all">(
    sources && sources.length === 1 ? sources[0] : "all"
  )
  const [sessionFilter, setSessionFilter] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [useRegex, setUseRegex] = useState(false)
  const [highSeverityOnly, setHighSeverityOnly] = useState(false)
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
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(50)
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
  const [activePresetId, setActivePresetId] = useState<string>(EMPTY_PRESET_VALUE)

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

  const saveCurrentPreset = useCallback(() => {
    const defaultName = `Preset ${presets.length + 1}`
    const presetFilters: LogFilterPresetFilters = {
      levelFilter: levelFilter as LogLevel | "all",
      moduleFilter,
      timeRange,
      searchQuery,
      useRegex,
      highSeverityOnly,
    }
    const preset = createLogFilterPreset(defaultName, presetFilters)
    const next = [...presets, preset]
    setPresets(next)
    setActivePresetId(preset.id)
    persistPresets(next)
  }, [
    presets,
    levelFilter,
    moduleFilter,
    timeRange,
    searchQuery,
    useRegex,
    highSeverityOnly,
    persistPresets,
  ])

  const applyPreset = useCallback((preset: LogFilterPreset) => {
    setLevelFilter(preset.filters.levelFilter)
    setModuleFilter(preset.filters.moduleFilter)
    setTimeRange(preset.filters.timeRange)
    setSearchQuery(preset.filters.searchQuery)
    setUseRegex(preset.filters.useRegex)
    setHighSeverityOnly(preset.filters.highSeverityOnly)
    setActivePresetId(preset.id)
  }, [])

  const removeActivePreset = useCallback(() => {
    if (activePresetId === EMPTY_PRESET_VALUE) return
    const next = presets.filter((preset) => preset.id !== activePresetId)
    setPresets(next)
    setActivePresetId(EMPTY_PRESET_VALUE)
    persistPresets(next)
  }, [activePresetId, presets, persistPresets])

  const handlePresetChange = useCallback(
    (presetId: string) => {
      if (presetId === EMPTY_PRESET_VALUE) {
        setActivePresetId(EMPTY_PRESET_VALUE)
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

  const handleFocusTrace = useCallback((traceId: string, log: StructuredLogEntry) => {
    setTraceFocusId(traceId)
    setModuleFilter("all")
    setSelectedLog(log)
    setShowDetailPanel(true)
  }, [])

  const handleFocusSession = useCallback((sessionId: string, log: StructuredLogEntry) => {
    setSessionFilter(sessionId)
    setSelectedLog(log)
    setShowDetailPanel(false)
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
      highSeverityOnly,
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
      currentPage,
      pageSize,
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
      setHighSeverityOnly,
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
      setCurrentPage,
      setPageSize,
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
      highSeverityOnly,
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
      currentPage,
      pageSize,
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
