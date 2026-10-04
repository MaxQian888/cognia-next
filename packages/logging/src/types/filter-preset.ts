/**
 * Log Filter Preset Types
 */

import type { LogLevel } from "./log-level"

export type PresetLevel = LogLevel | "all"
export type PresetTimeRange = "15m" | "1h" | "6h" | "24h" | "7d" | "all"

export interface LogFilterPresetFilters {
  levelFilter: PresetLevel
  moduleFilter: string
  timeRange: PresetTimeRange
  searchQuery: string
  useRegex: boolean
  /**
   * Legacy flag from the days the Error tab was "all levels + an error-only
   * toggle". The panel no longer has the toggle — the Error tab itself carries
   * error + fatal — so it now only round-trips for compatibility: presets
   * still write it (as `levelFilter === "error"`) because the v1 validator in
   * `filter-presets.ts` requires a boolean, and applying an old preset with
   * `levelFilter: "all"` and this flag set lands on the Error tab.
   */
  highSeverityOnly: boolean
  /*
   * The facets below were added after v1. They are optional so every preset
   * saved before them still loads (the validator ignores unknown keys), and an
   * absent key restores the facet's default rather than leaving the previous
   * value behind.
   */
  /** Source facet (`frontend` / `tauri` / …), or `"all"`. */
  sourceFilter?: string
  /** Session id the list is narrowed to; empty for none. */
  sessionFilter?: string
  /** Pinned absolute range, epoch ms. Wins over `timeRange` when set. */
  customTimeRange?: { start: number; end: number } | null
  /** Trace the list is focused on. */
  traceFocusId?: string | null
  /** Logger transport whose diagnostics the list is narrowed to. */
  diagnosticTransportFilter?: string | null
}

export interface LogFilterPreset {
  id: string
  name: string
  version: number
  createdAt: string
  filters: LogFilterPresetFilters
}
