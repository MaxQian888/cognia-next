/**
 * Log Filter Presets — persistence helpers.
 *
 * Small pure helpers that serialise the log panel's filter chips into
 * localStorage. Types live in `@/types/logging/filter-preset` so hooks
 * can consume them without crossing into the components layer.
 */

import type {
  LogFilterPreset,
  LogFilterPresetFilters,
  PresetLevel,
  PresetTimeRange,
} from "@/types/logging"

export type { LogFilterPreset, LogFilterPresetFilters, PresetLevel, PresetTimeRange }

export const LOG_FILTER_PRESETS_STORAGE_KEY = "cognia-log-filter-presets"
const LOG_FILTER_PRESETS_SCHEMA_VERSION = 1

const VALID_LEVELS = new Set<PresetLevel>([
  "all",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
])
const VALID_TIME_RANGES = new Set<PresetTimeRange>(["all", "15m", "1h", "6h", "24h", "7d"])

export function createLogFilterPreset(
  name: string,
  filters: LogFilterPresetFilters,
  id = `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
): LogFilterPreset {
  return {
    id,
    name: name.trim(),
    version: LOG_FILTER_PRESETS_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    filters,
  }
}

export function loadLogFilterPresets(raw: string | null): LogFilterPreset[] {
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter(isValidPreset)
  } catch {
    return []
  }
}

export function serializeLogFilterPresets(presets: LogFilterPreset[]): string {
  return JSON.stringify(presets)
}

function isValidPreset(value: unknown): value is LogFilterPreset {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as Partial<LogFilterPreset>
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.version !== "number" ||
    !candidate.filters ||
    typeof candidate.filters !== "object"
  ) {
    return false
  }

  const filters = candidate.filters as Partial<LogFilterPresetFilters>
  if (
    typeof filters.moduleFilter !== "string" ||
    typeof filters.searchQuery !== "string" ||
    typeof filters.useRegex !== "boolean" ||
    typeof filters.highSeverityOnly !== "boolean"
  ) {
    return false
  }

  if (!VALID_LEVELS.has(filters.levelFilter as PresetLevel)) {
    return false
  }

  if (!VALID_TIME_RANGES.has(filters.timeRange as PresetTimeRange)) {
    return false
  }

  return true
}
