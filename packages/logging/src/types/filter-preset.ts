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
  highSeverityOnly: boolean
}

export interface LogFilterPreset {
  id: string
  name: string
  version: number
  createdAt: string
  filters: LogFilterPresetFilters
}
