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
 *
 * {@link normalizePanelLayouts} is the other half of an import: a parsed layout
 * is only structurally valid, and react-grid-layout invents an unreadable
 * `{w:1,h:1}` tile at the bottom of the grid for any panel the layout has no
 * entry for (and keeps any undersized one undersized). The defaults it fills
 * from are passed in rather than imported, so this module stays free of the
 * component-side panel registry.
 */

import type {
  PanelLayouts,
  PanelLayoutItem,
  RefreshMs,
} from "@/stores/observability/observability-store"
import { REFRESH_OPTIONS } from "@/stores/observability/observability-store"
import type { RangePreset } from "./time-range"
import { RANGE_PRESETS } from "./time-range"
import { sanitizeFilters, type TraceFilters } from "./filters"
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

const BREAKPOINT_KEYS = ["lg", "md", "sm"] as const

function finiteAtLeast(value: number | undefined, floor: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(floor, value) : floor
}

/**
 * Make a stored or imported layout safe to hand to the grid:
 *
 *  - every panel in `defaults` gets an item at every breakpoint — a missing
 *    one is filled from the default entry for that id, min sizes included;
 *  - a present item keeps its position but is clamped to the default entry's
 *    `minW` / `minH` (which are re-asserted, so an edited file cannot lift
 *    them) and to non-negative coordinates;
 *  - ids the registry no longer knows, and duplicates, are dropped — they
 *    would otherwise ride along in every exported config forever.
 *
 * Pure; `defaults` is `defaultLayouts()` from the panel registry.
 */
export function normalizePanelLayouts(
  layouts: PanelLayouts | null | undefined,
  defaults: PanelLayouts
): PanelLayouts {
  const out = { lg: [], md: [], sm: [] } as PanelLayouts
  for (const bp of BREAKPOINT_KEYS) {
    const fallback = new Map(defaults[bp].map((item) => [item.i, item]))
    const seen = new Set<string>()
    for (const item of layouts?.[bp] ?? []) {
      const base = fallback.get(item.i)
      if (!base || seen.has(item.i)) continue
      seen.add(item.i)
      const minW = base.minW ?? 1
      const minH = base.minH ?? 1
      out[bp].push({
        i: item.i,
        x: finiteAtLeast(item.x, 0),
        y: finiteAtLeast(item.y, 0),
        w: finiteAtLeast(item.w, minW),
        h: finiteAtLeast(item.h, minH),
        minW,
        minH,
      })
    }
    for (const base of defaults[bp]) {
      if (!seen.has(base.i)) out[bp].push({ ...base })
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
    filters: sanitizeFilters(raw.filters),
  }
}
