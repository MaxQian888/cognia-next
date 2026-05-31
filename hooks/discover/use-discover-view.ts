"use client"

/**
 * Per-category view mode (grid / list / compact) for the discover page.
 *
 * Persisted on `AppSettings.discoverViewByCategory` (a `{ [category]: mode }`
 * map) via `useSettingsStore.save()`. Unlike the workflow library toggle —
 * which is a localStorage-backed zustand store — discover view prefs sync
 * cross-device through the settings singleton, and each category remembers its
 * own mode.
 */

import { useCallback } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_DISCOVER_VIEW,
  type DiscoverView,
  type DiscoverViewMode,
} from "@/lib/discover/categories"

export interface UseDiscoverView {
  /** The stored view mode for `category`, or the default if unset. */
  view: (category: DiscoverView) => DiscoverViewMode
  setView: (category: DiscoverView, mode: DiscoverViewMode) => Promise<void>
}

export function useDiscoverView(): UseDiscoverView {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const byCategory = settings?.discoverViewByCategory

  const view = useCallback(
    (category: DiscoverView): DiscoverViewMode => byCategory?.[category] ?? DEFAULT_DISCOVER_VIEW,
    [byCategory]
  )

  const setView = useCallback(
    async (category: DiscoverView, mode: DiscoverViewMode) => {
      await save({ discoverViewByCategory: { ...(byCategory ?? {}), [category]: mode } })
    },
    [byCategory, save]
  )

  return { view, setView }
}
