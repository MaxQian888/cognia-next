"use client"

/**
 * Two-way sync between the trace channel's *view* controls (time range +
 * filters) and the page URL, so a link is shareable and reproduces what the
 * sender saw.
 *
 * - On mount, a deep-link (`?range=…&f=…`) hydrates the store, taking priority
 *   over persisted state (you followed a link — you want the link's view).
 * - After that, control changes are mirrored back via `history.replaceState`
 *   (no navigation, no history spam). The first write is skipped so simply
 *   opening `/logs` with no params doesn't dirty the URL.
 *
 * Only the four params this module owns (`range` / `from` / `to` / `f`) are
 * rewritten; everything else in the query survives untouched. That matters now
 * that the dashboard lives on `/logs`, where `channel`, `view`, `traceId` and
 * the log panel's own filter params share the same URL — the old
 * "replace the whole query string" write would have deleted them on the first
 * range change.
 *
 * Client-only and static-export safe: pure `window.history`/`location`, no RSC
 * navigation.
 */

import { useEffect, useRef } from "react"
import {
  OBSERVABILITY_URL_PARAMS,
  useObservabilityStore,
} from "@/stores/observability/observability-store"
import { decodeControls, encodeControls } from "@/lib/observability/url-state"

/**
 * Query params this hook owns. Everything else in the URL is preserved.
 *
 * Defined on the store (and re-exported here) because this hook is only mounted
 * while the Traces channel is on screen, yet the channel's "Reset" lives in the
 * page header and is reachable from every channel. `resetView` clears them
 * itself — otherwise the store resets, nothing rewrites the query, and the next
 * visit to Traces re-hydrates the range and filters straight back out of the URL.
 */
export { OBSERVABILITY_URL_PARAMS }

const OWNED_PARAMS = OBSERVABILITY_URL_PARAMS

export function useObservabilityUrlSync(): void {
  const rangePreset = useObservabilityStore((s) => s.rangePreset)
  const customSince = useObservabilityStore((s) => s.customSince)
  const customUntil = useObservabilityStore((s) => s.customUntil)
  const filters = useObservabilityStore((s) => s.filters)
  const setRangePreset = useObservabilityStore((s) => s.setRangePreset)
  const setCustomRange = useObservabilityStore((s) => s.setCustomRange)
  const setFilters = useObservabilityStore((s) => s.setFilters)

  const hydrated = useRef(false)
  const firstWrite = useRef(true)

  // One-time hydrate from the URL — a deep-link overrides persisted controls.
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true
    if (typeof window === "undefined") return
    const decoded = decodeControls(window.location.search)
    if (!decoded) return
    if (decoded.rangePreset === "custom") {
      if (decoded.customSince !== null && decoded.customUntil !== null) {
        setCustomRange(decoded.customSince, decoded.customUntil)
      }
    } else {
      setRangePreset(decoded.rangePreset)
    }
    setFilters(decoded.filters)
  }, [setRangePreset, setCustomRange, setFilters])

  // Mirror controls into the URL. Skip the first run so a pristine load stays clean.
  useEffect(() => {
    if (typeof window === "undefined") return
    if (firstWrite.current) {
      firstWrite.current = false
      return
    }
    const params = new URLSearchParams(window.location.search)
    for (const key of OWNED_PARAMS) params.delete(key)
    for (const [key, value] of encodeControls({
      rangePreset,
      customSince,
      customUntil,
      filters,
    })) {
      params.set(key, value)
    }
    const qs = params.toString()
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    window.history.replaceState(window.history.state, "", url)
  }, [rangePreset, customSince, customUntil, filters])
}
