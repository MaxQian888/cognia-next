/**
 * Threshold evaluation + color mapping for stat / time-series panels.
 *
 * A metric is "ok" until it crosses `warn`, then "warn" until it crosses
 * `crit`. `direction` flips the comparison: `"above"` for metrics that are
 * worse when high (error rate, latency, cost); `"below"` for metrics that are
 * worse when low (cache hit rate).
 */

import type { ThemeColorKey } from "@/types/logging"

export type ThresholdLevel = "ok" | "warn" | "crit"
export type ThresholdDirection = "above" | "below"

export interface ThresholdConfig {
  warn: number
  crit: number
  direction: ThresholdDirection
}

/** Metric keys that ship with a default threshold. */
export type ThresholdMetric = "errorRate" | "latencyP95" | "cost" | "cacheHitRate"

export const DEFAULT_THRESHOLDS: Record<ThresholdMetric, ThresholdConfig> = {
  // error rate as a fraction 0..1
  errorRate: { warn: 0.02, crit: 0.1, direction: "above" },
  // p95 latency in ms
  latencyP95: { warn: 5_000, crit: 15_000, direction: "above" },
  // total cost in USD for the window
  cost: { warn: 5, crit: 20, direction: "above" },
  // cache hit rate as a fraction 0..1 (worse when low)
  cacheHitRate: { warn: 0.5, crit: 0.2, direction: "below" },
}

/** User overrides for the shipped defaults — a partial map keyed by metric.
 * Each entry may override just `warn`/`crit` (direction is fixed per metric,
 * so it's never user-editable). Persisted in the observability store. */
export type ThresholdOverrides = Partial<Record<ThresholdMetric, { warn: number; crit: number }>>

/**
 * Merge user overrides onto the shipped defaults, returning a complete map.
 * `direction` is always taken from the default (it's a property of the metric,
 * not a user preference); a NaN/non-finite override bound falls back to the
 * default for that bound so a half-typed value can't disable coloring.
 */
export function mergeThresholds(
  overrides: ThresholdOverrides | undefined
): Record<ThresholdMetric, ThresholdConfig> {
  if (!overrides) return DEFAULT_THRESHOLDS
  const out = {} as Record<ThresholdMetric, ThresholdConfig>
  for (const metric of Object.keys(DEFAULT_THRESHOLDS) as ThresholdMetric[]) {
    const base = DEFAULT_THRESHOLDS[metric]
    const ov = overrides[metric]
    out[metric] = {
      warn: ov && Number.isFinite(ov.warn) ? ov.warn : base.warn,
      crit: ov && Number.isFinite(ov.crit) ? ov.crit : base.crit,
      direction: base.direction,
    }
  }
  return out
}

/** Classify a value against a threshold config. */
export function evalThreshold(value: number, cfg: ThresholdConfig): ThresholdLevel {
  if (cfg.direction === "above") {
    if (value >= cfg.crit) return "crit"
    if (value >= cfg.warn) return "warn"
    return "ok"
  }
  // "below": worse as the value drops
  if (value <= cfg.crit) return "crit"
  if (value <= cfg.warn) return "warn"
  return "ok"
}

/** Theme color key for a level — resolved to oklch by `useThemeColors` (SVG)
 * or used as a `text-*` Tailwind class token (HTML). */
export function thresholdColorVar(level: ThresholdLevel): ThemeColorKey {
  switch (level) {
    case "crit":
      return "destructive"
    case "warn":
      return "warning"
    case "ok":
      return "success"
  }
}
