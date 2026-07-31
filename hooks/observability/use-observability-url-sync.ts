"use client"

/**
 * Two-way sync between the dashboard's *view* controls (time range + filters)
 * and the page URL, so a link is shareable and reproduces what the sender saw.
 *
 * - On mount, a deep-link (`?range=…&f=…`) hydrates the store, taking priority
 *   over persisted state (you followed a link — you want the link's view).
 * - After that, control changes are mirrored back via `history.replaceState`
 *   (no navigation, no history spam). The first write is skipped so simply
 *   opening `/observability` with no params doesn't dirty the URL.
 *
 * Client-only and static-export safe: pure `window.history`/`location`, no RSC
 * navigation.
 */

import { useEffect, useRef } from "react"
import { useObservabilityStore } from "@/stores/observability/observability-store"
import { decodeControls, encodeControlsString } from "@/lib/observability/url-state"

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
    const qs = encodeControlsString({ rangePreset, customSince, customUntil, filters })
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    window.history.replaceState(window.history.state, "", url)
  }, [rangePreset, customSince, customUntil, filters])
}
