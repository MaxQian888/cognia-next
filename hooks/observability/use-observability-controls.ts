"use client"

/**
 * Thin selector layer over `useObservabilityStore` for the dashboard toolbar,
 * plus `useResolvedRange` which turns the persisted range controls into an
 * absolute `TimeRange` that slides with the refresh tick.
 */

import { useMemo } from "react"
import { useObservabilityStore } from "@/stores/observability/observability-store"
import { resolveControlsRange, type TimeRange } from "@/lib/observability/time-range"

export function useObservabilityControls() {
  const rangePreset = useObservabilityStore((s) => s.rangePreset)
  const customSince = useObservabilityStore((s) => s.customSince)
  const customUntil = useObservabilityStore((s) => s.customUntil)
  const refreshMs = useObservabilityStore((s) => s.refreshMs)
  const filters = useObservabilityStore((s) => s.filters)
  const editMode = useObservabilityStore((s) => s.editMode)

  const setRangePreset = useObservabilityStore((s) => s.setRangePreset)
  const setCustomRange = useObservabilityStore((s) => s.setCustomRange)
  const setRefreshMs = useObservabilityStore((s) => s.setRefreshMs)
  const setFilters = useObservabilityStore((s) => s.setFilters)
  const setEditMode = useObservabilityStore((s) => s.setEditMode)
  const setLayouts = useObservabilityStore((s) => s.setLayouts)
  const resetLayouts = useObservabilityStore((s) => s.resetLayouts)

  return {
    rangePreset,
    customSince,
    customUntil,
    refreshMs,
    filters,
    editMode,
    setRangePreset,
    setCustomRange,
    setRefreshMs,
    setFilters,
    setEditMode,
    setLayouts,
    resetLayouts,
  }
}

/**
 * Resolve the persisted range controls into an absolute window. `tick` is the
 * value from `useRefreshTick`; putting it in the dep list makes relative
 * presets recompute `until = now` on every refresh so the window slides.
 */
export function useResolvedRange(tick: number): TimeRange {
  const rangePreset = useObservabilityStore((s) => s.rangePreset)
  const customSince = useObservabilityStore((s) => s.customSince)
  const customUntil = useObservabilityStore((s) => s.customUntil)

  return useMemo(() => {
    // Reading `tick` makes it a genuine dependency: relative presets re-resolve
    // `until = now` on every refresh so the window slides forward. The current
    // time is read inside `resolveControlsRange` (its default `now` arg), not
    // here, keeping this render free of an impure `Date.now()` literal.
    void tick
    return resolveControlsRange(rangePreset, customSince, customUntil)
  }, [rangePreset, customSince, customUntil, tick])
}
