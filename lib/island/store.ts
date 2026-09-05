"use client"

/**
 * Island preferences, persisted through the same Tauri Store plugin the tray
 * layout and the Capacity Dock use.
 *
 * One preference today: how much detail the overlay is allowed to receive. It
 * lives here rather than in `AppSettings` because the island window itself
 * never hydrates app settings, and the main window has to know the answer
 * before it builds the very first projection.
 */

import { create } from "zustand"
import { loggers } from "@cognia/logging"

import { getPref, setPref } from "@/lib/tauri/store"

import {
  DEFAULT_ISLAND_PREFERENCES,
  mergeIslandPreferences,
  type IslandPreferencesV1,
} from "./types"

export const ISLAND_PREF = "island.preferences.v1"

interface IslandStoreState {
  preferences: IslandPreferencesV1
  hydrated: boolean
  hydrate(): Promise<void>
  setPreferences(patch: Partial<IslandPreferencesV1>): void
}

export const useIslandStore = create<IslandStoreState>((set, get) => ({
  preferences: DEFAULT_ISLAND_PREFERENCES,
  hydrated: false,

  async hydrate(): Promise<void> {
    try {
      const stored = await getPref<unknown>(ISLAND_PREF)
      set({ preferences: mergeIslandPreferences(stored), hydrated: true })
    } catch (error) {
      // A missing or corrupt blob leaves the island on `click-to-reveal`, the
      // most private of the three. Failing closed is the right direction when
      // the failure decides how much a hover shows.
      loggers.tray?.warn?.("island: hydrate failed", { error: String(error) })
      set({ hydrated: true })
    }
  },

  setPreferences(patch: Partial<IslandPreferencesV1>): void {
    const next = mergeIslandPreferences({ ...get().preferences, ...patch })
    set({ preferences: next })
    void setPref(ISLAND_PREF, next).catch((error: unknown) => {
      loggers.tray?.warn?.("island: persisting preferences failed", { error: String(error) })
    })
  },
}))

/** Test seam: drop the store back to its shipped defaults. */
export function __resetIslandStoreForTesting(): void {
  useIslandStore.setState({ preferences: DEFAULT_ISLAND_PREFERENCES, hydrated: false })
}
