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
  /**
   * Keyboard cursor (j / k / arrows) as an index into the panel's filtered
   * list. There is no page any more — the list is virtualized over the whole
   * loaded window — so the index is absolute and the cursor, the detail pane's
   * prev / next and the URL selection all address the same rows.
   */
  focusedIndex: number
  density: Density

  // Presets
  presets: LogFilterPreset[]
  /**
   * The applied preset, or `EMPTY_PRESET_VALUE`. Derived, not stored: it reads
   * as the preset's id only while every facet the preset carries still matches
   * the live filters, so the picker stops claiming "Errors last hour" the
   * moment the user widens the range by hand.
   */
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
  setDensity: (v: Density) => void

  // Expansion
  toggleExpanded: (id: string) => void

  // Bookmarks
  toggleBookmark: (id: string) => void

  // Presets
  /** Saves the current filters as a preset. `name` is the user's label; a
   * blank name falls back to a numbered default so a preset is never nameless. */
  saveCurrentPreset: (name?: string) => void
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
  /**
   * Namespace for the panel's per-embed preferences (live follow). The panel
   * is embedded twice — `/logs` and Settings → MCP → Health & Logs, which
   * defaults to live — and with one shared key turning Live off in one place
   * turned it off in the other on its next mount. Omitted, the hook keeps the
   * original unscoped key, so the `/logs` preference survives the change.
   */
  storageScope?: string
}
