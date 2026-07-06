"use client"

/**
 * Global defaults for the `/discover` page, persisted on
 * `AppSettings.discoverDefaults` via `useSettingsStore.save()`. Same
 * settings-singleton pattern as `useDiscoverView` / `useDiscoverFavorites`, so
 * the chosen defaults sync cross-device with no Dexie migration.
 *
 *  - `landingCategory`: which category the page opens on when `?category=` is
 *    absent (`null` = auto → first visible category).
 *  - `view`: the fallback view mode for categories with no explicit
 *    per-category override in `discoverViewByCategory`.
 *
 * Edited from `/settings?section=discover` (`<DiscoverPreferences />`) and
 * consumed by `useDiscoverView` (view fallback) + the discover bodies (landing).
 */

import { useCallback, useMemo } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_DISCOVER_VIEW,
  isValidView,
  isValidViewMode,
  type DiscoverView,
  type DiscoverViewMode,
} from "@/lib/discover/categories"

export interface DiscoverPreferences {
  /** Preferred landing category, or `null` to fall back to the first visible one. */
  landingCategory: DiscoverView | null
  /** Fallback view mode for categories without a per-category override. */
  view: DiscoverViewMode
}

export interface UseDiscoverPreferences {
  preferences: DiscoverPreferences
  setLandingCategory: (id: DiscoverView | null) => Promise<void>
  setDefaultView: (mode: DiscoverViewMode) => Promise<void>
  /** True when both knobs are still at their factory defaults. */
  isDefault: boolean
  /** Clear both defaults (auto landing + registry-default view). */
  reset: () => Promise<void>
}

export function useDiscoverPreferences(): UseDiscoverPreferences {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const defaults = settings?.discoverDefaults

  const preferences = useMemo<DiscoverPreferences>(() => {
    const rawLanding = defaults?.landingCategory
    const rawView = defaults?.view
    return {
      landingCategory: isValidView(rawLanding) ? rawLanding : null,
      view: isValidViewMode(rawView) ? rawView : DEFAULT_DISCOVER_VIEW,
    }
  }, [defaults])

  const setLandingCategory = useCallback(
    async (id: DiscoverView | null) => {
      await save({ discoverDefaults: { ...(defaults ?? {}), landingCategory: id ?? undefined } })
    },
    [defaults, save]
  )

  const setDefaultView = useCallback(
    async (mode: DiscoverViewMode) => {
      await save({ discoverDefaults: { ...(defaults ?? {}), view: mode } })
    },
    [defaults, save]
  )

  const isDefault =
    preferences.landingCategory === null && preferences.view === DEFAULT_DISCOVER_VIEW

  const reset = useCallback(async () => {
    await save({ discoverDefaults: {} })
  }, [save])

  return { preferences, setLandingCategory, setDefaultView, isDefault, reset }
}
