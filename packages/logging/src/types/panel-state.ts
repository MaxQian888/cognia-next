/**
 * Log Panel State Types
 */

import type { LogLevel } from "./log-level"
import type { StructuredLogEntry } from "./log-entry"
import type { LogFilterPreset, PresetTimeRange } from "./filter-preset"

export type ViewMode = "list" | "dashboard" | "trace"
export type PanelSource = "frontend" | "tauri" | "mcp" | "plugin" | "internal"
export type Density = "compact" | "comfortable" | "spacious"

export interface LogPanelFilterState {
  // Filter values
  autoRefresh: boolean
  levelFilter: LogLevel | "all"
  moduleFilter: string
  sourceFilter: PanelSource | "all"
  sessionFilter: string
  searchQuery: string
  useRegex: boolean
  highSeverityOnly: boolean
  timeRange: PresetTimeRange
  customTimeRange: { start: Date; end: Date } | null
  traceFocusId: string | null
  autoScroll: boolean
  viewMode: ViewMode
  selectedLog: StructuredLogEntry | null
  showDetailPanel: boolean
  selectedTransportHealthName: string | null
  selectedNativeLogging: boolean
  diagnosticTransportFilter: string | null
  expandedIds: Set<string>
  focusedIndex: number
  currentPage: number
  pageSize: number
  density: Density

  // Presets
  presets: LogFilterPreset[]
  activePresetId: string

  // Bookmarks
  bookmarkedIds: Set<string>

  // New UI toggles and search history
  bookmarkFilterActive: boolean
  setBookmarkFilterActive: (v: boolean) => void
  showAdvancedFilters: boolean
  setShowAdvancedFilters: (v: boolean) => void
  showShortcutsDialog: boolean
  setShowShortcutsDialog: (v: boolean) => void
  searchHistory: string[]
  addSearchHistory: (query: string) => void
  removeSearchHistoryItem: (query: string) => void
  clearSearchHistory: () => void

  // Setters
  setAutoRefresh: (v: boolean) => void
  setLevelFilter: (v: LogLevel | "all") => void
  setModuleFilter: (v: string) => void
  setSourceFilter: (v: PanelSource | "all") => void
  setSessionFilter: (v: string) => void
  setSearchQuery: (v: string) => void
  setUseRegex: (v: boolean) => void
  setHighSeverityOnly: (v: boolean | ((prev: boolean) => boolean)) => void
  setTimeRange: (v: PresetTimeRange) => void
  setCustomTimeRange: (v: { start: Date; end: Date } | null) => void
  setTraceFocusId: (v: string | null) => void
  setAutoScroll: (v: boolean) => void
  setViewMode: (v: ViewMode | ((prev: ViewMode) => ViewMode)) => void
  setSelectedLog: (v: StructuredLogEntry | null) => void
  setShowDetailPanel: (v: boolean) => void
  setSelectedTransportHealthName: (v: string | null) => void
  setSelectedNativeLogging: (v: boolean) => void
  setDiagnosticTransportFilter: (v: string | null) => void
  setFocusedIndex: (v: number | ((prev: number) => number)) => void
  setCurrentPage: (v: number | ((prev: number) => number)) => void
  setPageSize: (v: number) => void
  setDensity: (v: Density) => void

  // Expansion
  toggleExpanded: (id: string) => void

  // Bookmarks
  toggleBookmark: (id: string) => void

  // Presets
  saveCurrentPreset: () => void
  applyPreset: (preset: LogFilterPreset) => void
  handlePresetChange: (presetId: string) => void
  removeActivePreset: () => void

  // Handlers
  handleSelectLog: (log: StructuredLogEntry) => void
  handleFocusTrace: (traceId: string, log: StructuredLogEntry) => void
  handleFocusSession: (sessionId: string, log: StructuredLogEntry) => void

  // Constants
  EMPTY_PRESET_VALUE: string
}

export interface UseLogPanelFiltersOptions {
  defaultAutoRefresh?: boolean
  sources?: ("frontend" | "tauri" | "mcp" | "plugin")[]
  /**
   * Row density, controlled by the host.
   *
   * Left undefined, the hook owns density itself and persists it under
   * `cognia-log-density`. Supplied, the host is the single source of truth and
   * the hook stops writing that key — which is what stops a page that has its
   * own density preference (the `/logs` workspace store) from shadowing the
   * panel with a second, silently diverging value.
   */
  density?: Density
  /** Required for `density` to be honoured; without it there is nothing to
   * write back to and the control would render inert. */
  onDensityChange?: (density: Density) => void
}
