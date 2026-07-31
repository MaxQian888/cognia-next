/**
 * Portable dashboard configuration: the shareable/back-uppable subset of the
 * observability store (panel layout, panel visibility, threshold overrides,
 * time-range + refresh defaults, and active filters).
 *
 * Pure — `serializeDashboardConfig` produces pretty JSON; `parseDashboardConfig`
 * validates untrusted input (a file the user picked) and returns `null` on
 * anything malformed rather than throwing, so the import UI degrades to a
 * toast. Unknown/extra keys are ignored; missing keys fall back to defaults so
 * a config exported by an older build still imports.
 */

import type {
  PanelLayouts,
  PanelLayoutItem,
  RefreshMs,
} from "@/stores/observability/observability-store"
import { REFRESH_OPTIONS } from "@/stores/observability/observability-store"
import type { RangePreset } from "./time-range"
import { RANGE_PRESETS } from "./time-range"
import type { TraceFilters } from "./filters"
import type { ThresholdOverrides } from "./thresholds"
import type { ThresholdMetric } from "./thresholds"

export const DASHBOARD_CONFIG_VERSION = 1 as const

export interface DashboardConfig {
  version: typeof DASHBOARD_CONFIG_VERSION
  layouts: PanelLayouts | null
  hiddenPanels: string[]
  thresholds: ThresholdOverrides
  rangePreset: RangePreset | "custom"
  customSince: number | null
  customUntil: number | null
  refreshMs: RefreshMs
  filters: TraceFilters
}

/** Serialize a config to pretty-printed JSON for download. */
export function serializeDashboardConfig(cfg: DashboardConfig): string {
  return JSON.stringify(cfg, null, 2)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isLayoutItem(v: unknown): v is PanelLayoutItem {
  if (!isObject(v)) return false
  return (
    typeof v.i === "string" &&
    typeof v.x === "number" &&
    typeof v.y === "number" &&
    typeof v.w === "number" &&
    typeof v.h === "number"
  )
}

function parseLayouts(v: unknown): PanelLayouts | null {
  if (!isObject(v)) return null
  const bp = (key: "lg" | "md" | "sm"): PanelLayoutItem[] => {
    const arr = v[key]
    return Array.isArray(arr) ? arr.filter(isLayoutItem) : []
  }
  return { lg: bp("lg"), md: bp("md"), sm: bp("sm") }
}

function parseThresholds(v: unknown): ThresholdOverrides {
  if (!isObject(v)) return {}
  const out: ThresholdOverrides = {}
  const metrics: ThresholdMetric[] = ["errorRate", "latencyP95", "cost", "cacheHitRate"]
  for (const m of metrics) {
    const entry = v[m]
    if (isObject(entry) && typeof entry.warn === "number" && typeof entry.crit === "number") {
      out[m] = { warn: entry.warn, crit: entry.crit }
    }
  }
  return out
}

function parseFilters(v: unknown): TraceFilters {
  if (!isObject(v)) return {}
  const out: TraceFilters = {}
  for (const dim of ["model", "surface", "operation", "tool", "session"] as const) {
    const arr = v[dim]
    if (Array.isArray(arr)) {
      const vals = arr.filter((x): x is string => typeof x === "string")
      if (vals.length > 0) (out[dim] as string[]) = vals
    }
  }
  return out
}

/**
 * Validate + normalize untrusted JSON into a `DashboardConfig`. Returns null on
 * unparseable JSON or a non-object root. All fields are individually validated
 * and defaulted, so a partial/older config still yields a usable result.
 */
export function parseDashboardConfig(json: string): DashboardConfig | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!isObject(raw)) return null

  const rangePreset =
    raw.rangePreset === "custom" || RANGE_PRESETS.includes(raw.rangePreset as RangePreset)
      ? (raw.rangePreset as RangePreset | "custom")
      : "1h"
  const refreshMs = REFRESH_OPTIONS.includes(raw.refreshMs as RefreshMs)
    ? (raw.refreshMs as RefreshMs)
    : 10_000

  return {
    version: DASHBOARD_CONFIG_VERSION,
    layouts: parseLayouts(raw.layouts),
    hiddenPanels: Array.isArray(raw.hiddenPanels)
      ? raw.hiddenPanels.filter((x): x is string => typeof x === "string")
      : [],
    thresholds: parseThresholds(raw.thresholds),
    rangePreset,
    customSince: typeof raw.customSince === "number" ? raw.customSince : null,
    customUntil: typeof raw.customUntil === "number" ? raw.customUntil : null,
    refreshMs,
    filters: parseFilters(raw.filters),
  }
}
