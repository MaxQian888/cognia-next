/**
 * Time-range model for the observability dashboard.
 *
 * Generalizes the `windowToSince` switch that was inline in
 * `components/logging/agent-trace-stats-bar.tsx` into a reusable
 * relative-preset / absolute-custom range with Grafana-style bucket sizing.
 *
 * Pure module — no Dexie, no React. `now` is always injectable so tests are
 * deterministic (the project bans `Date.now()` in some contexts; here it's
 * the default-arg only).
 */

/** Grafana-style relative window presets. */
export type RangePreset = "5m" | "15m" | "1h" | "6h" | "24h" | "7d" | "30d"

/** Resolved absolute window. `preset === "custom"` means user-pinned bounds. */
export interface TimeRange {
  since: number
  until: number
  preset: RangePreset | "custom"
}

const PRESET_MS: Record<RangePreset, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
}

/** Ordered preset list for rendering the picker. */
export const RANGE_PRESETS: readonly RangePreset[] = [
  "5m",
  "15m",
  "1h",
  "6h",
  "24h",
  "7d",
  "30d",
] as const

/** Window length in ms for a preset. */
export function presetDurationMs(preset: RangePreset): number {
  return PRESET_MS[preset]
}

/** Resolve a relative preset to absolute bounds ending at `now`. */
export function resolveRange(preset: RangePreset, now: number = Date.now()): TimeRange {
  return { since: now - PRESET_MS[preset], until: now, preset }
}

/** Build a pinned absolute range. Bounds are normalized so `since <= until`. */
export function customRange(since: number, until: number): TimeRange {
  const lo = Math.min(since, until)
  const hi = Math.max(since, until)
  return { since: lo, until: hi, preset: "custom" }
}

/**
 * Resolve the dashboard's persisted control state into an absolute range.
 * Relative presets slide with `now`; a "custom" preset with both bounds set
 * is frozen. A "custom" preset missing a bound falls back to the 1h preset.
 */
export function resolveControlsRange(
  preset: RangePreset | "custom",
  customSince: number | null,
  customUntil: number | null,
  now: number = Date.now()
): TimeRange {
  if (preset === "custom") {
    if (typeof customSince === "number" && typeof customUntil === "number") {
      return customRange(customSince, customUntil)
    }
    return resolveRange("1h", now)
  }
  return resolveRange(preset, now)
}

// Bucket sizes (ms) the picker snaps to, smallest → largest.
const BUCKET_STEPS_MS: readonly number[] = [
  1_000, // 1s
  5_000, // 5s
  10_000, // 10s
  30_000, // 30s
  60_000, // 1m
  300_000, // 5m
  900_000, // 15m
  3_600_000, // 1h
  21_600_000, // 6h
  86_400_000, // 1d
]

/**
 * Pick a bucket size that yields roughly `targetBuckets` buckets across the
 * range, snapped to a human-friendly step. Always returns a positive ms.
 */
export function pickBucketMs(range: TimeRange, targetBuckets = 60): number {
  const span = Math.max(1, range.until - range.since)
  const ideal = span / Math.max(1, targetBuckets)
  for (const step of BUCKET_STEPS_MS) {
    if (step >= ideal) return step
  }
  return BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1]
}

/**
 * Bucket start boundaries spanning the range, aligned to `since`. The last
 * boundary is <= `until`; callers assign a span to bucket
 * `floor((t - since) / bucketMs)`.
 */
export function bucketBoundaries(range: TimeRange, bucketMs: number): number[] {
  const safeBucket = Math.max(1, Math.floor(bucketMs))
  const span = Math.max(0, range.until - range.since)
  const count = Math.max(1, Math.floor(span / safeBucket) + 1)
  // Guard against pathological ranges producing millions of buckets.
  const capped = Math.min(count, 1000)
  const out: number[] = []
  for (let i = 0; i < capped; i++) out.push(range.since + i * safeBucket)
  return out
}
