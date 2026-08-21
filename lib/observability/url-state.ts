/**
 * URL <-> dashboard-controls codec for shareable observability links.
 *
 * Only the *view* controls that make a link meaningful travel in the URL — the
 * time range and the variable filters. Layout, thresholds and refresh cadence
 * stay in the persisted store (they're user preferences, not "what am I
 * looking at"). Pure and DOM-free; the `history.replaceState`/read wiring lives
 * in `hooks/observability/use-observability-url-sync.ts`.
 *
 * Param shape (all optional, all under an `obs`-free flat namespace so the URL
 * stays short and human-readable):
 *   ?range=1h                     relative preset
 *   ?range=custom&from=..&to=..    absolute window (epoch ms)
 *   ?f=<uri-encoded JSON filters>  active variable filters, when non-empty
 */

import { RANGE_PRESETS, type RangePreset } from "./time-range"
import { isFilterEmpty, type TraceFilters } from "./filters"

export interface UrlControls {
  rangePreset: RangePreset | "custom"
  customSince: number | null
  customUntil: number | null
  filters: TraceFilters
}

/** Encode controls into a `URLSearchParams`. Defaults are omitted so a pristine
 * dashboard produces an empty query string. */
export function encodeControls(c: UrlControls): URLSearchParams {
  const params = new URLSearchParams()
  if (c.rangePreset === "custom") {
    if (typeof c.customSince === "number" && typeof c.customUntil === "number") {
      params.set("range", "custom")
      params.set("from", String(c.customSince))
      params.set("to", String(c.customUntil))
    }
  } else if (c.rangePreset !== "1h") {
    // 1h is the store default — leave it out to keep clean links clean.
    params.set("range", c.rangePreset)
  }
  if (!isFilterEmpty(c.filters)) {
    params.set("f", JSON.stringify(c.filters))
  }
  return params
}

function parseFilters(raw: string | null): TraceFilters {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    const src = parsed as Record<string, unknown>
    const out: TraceFilters = {}
    for (const dim of [
      "model",
      "surface",
      "operation",
      "tool",
      "provider",
      "project",
      "session",
    ] as const) {
      const arr = src[dim]
      if (Array.isArray(arr)) {
        const vals = arr.filter((x): x is string => typeof x === "string")
        if (vals.length > 0) (out[dim] as string[]) = vals
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Decode controls from a query string or `URLSearchParams`. Returns `null` when
 * no observability params are present at all (so the caller can skip applying
 * anything and leave the persisted store untouched).
 */
export function decodeControls(search: string | URLSearchParams): UrlControls | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search
  const range = params.get("range")
  const f = params.get("f")
  if (range === null && f === null) return null

  let rangePreset: RangePreset | "custom" = "1h"
  let customSince: number | null = null
  let customUntil: number | null = null

  if (range === "custom") {
    const from = Number(params.get("from"))
    const to = Number(params.get("to"))
    if (Number.isFinite(from) && Number.isFinite(to)) {
      rangePreset = "custom"
      customSince = from
      customUntil = to
    }
  } else if (range !== null && RANGE_PRESETS.includes(range as RangePreset)) {
    rangePreset = range as RangePreset
  }

  return { rangePreset, customSince, customUntil, filters: parseFilters(f) }
}
