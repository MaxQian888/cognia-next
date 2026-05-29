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
