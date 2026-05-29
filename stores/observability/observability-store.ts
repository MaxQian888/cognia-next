"use client"

/**
 * Persisted UI state for the `/observability` dashboard: panel grid layout,
 * time-range selection, auto-refresh cadence and the variable filters.
 *
 * Kept as its own store (rather than bloating `stores/ui/ui-store.ts`) to
 * match the repo's per-domain store convention (`stores/terminal`,
 * `stores/workflow`, …) and to keep the heavily-shared UI store lean.
 *
 * `editMode` is intentionally transient (not persisted) — the grid always
 * reopens locked so a stray drag from a previous session can't shuffle panels
 * on load.
 */

import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import type { RangePreset } from "@/lib/observability/time-range"
import type { TraceFilters } from "@/lib/observability/filters"

export type Breakpoint = "lg" | "md" | "sm"

/** Minimal grid item shape — structurally compatible with react-grid-layout's
 * `Layout` so it round-trips through `onLayoutChange` without coupling the
 * store to the library. */
export interface PanelLayoutItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}

export type PanelLayouts = Record<Breakpoint, PanelLayoutItem[]>

/** Allowed auto-refresh cadences in ms (0 = off). */
export const REFRESH_OPTIONS = [0, 5_000, 10_000, 30_000, 60_000] as const
export type RefreshMs = (typeof REFRESH_OPTIONS)[number]

interface ObservabilityState {
  /** null → fall back to the registry default layout. */
  layouts: PanelLayouts | null
  rangePreset: RangePreset | "custom"
  customSince: number | null
  customUntil: number | null
  refreshMs: RefreshMs
  filters: TraceFilters
  editMode: boolean

  setLayouts: (layouts: PanelLayouts) => void
  resetLayouts: () => void
  setRangePreset: (preset: RangePreset) => void
  setCustomRange: (since: number, until: number) => void
  setRefreshMs: (ms: RefreshMs) => void
  setFilters: (filters: TraceFilters) => void
  setEditMode: (editMode: boolean) => void
}

export const useObservabilityStore = create<ObservabilityState>()(
  persist(
    (set) => ({
      layouts: null,
      rangePreset: "1h",
      customSince: null,
      customUntil: null,
      refreshMs: 10_000,
      filters: {},
      editMode: false,

      setLayouts: (layouts) => set({ layouts }),
      resetLayouts: () => set({ layouts: null }),
      setRangePreset: (preset) => set({ rangePreset: preset }),
      setCustomRange: (since, until) =>
        set({ rangePreset: "custom", customSince: since, customUntil: until }),
      setRefreshMs: (ms) => set({ refreshMs: ms }),
      setFilters: (filters) => set({ filters }),
      setEditMode: (editMode) => set({ editMode }),
    }),
    {
      name: "cognia-observability",
      storage: createJSONStorage(() => localStorage),
      // editMode stays transient — see file header.
      partialize: (s) => ({
        layouts: s.layouts,
        rangePreset: s.rangePreset,
        customSince: s.customSince,
        customUntil: s.customUntil,
        refreshMs: s.refreshMs,
        filters: s.filters,
      }),
    }
  )
)
