"use client"

// Zustand store holding the Capacity Dock's preferences in memory, persisted
// through the same Tauri Store plugin the tray layout uses so the dock comes
// back the way the user left it (ADR-0165 Phase 2).
//
// Deliberately its own store rather than a slice of the tray's. The two answer
// different questions, and merging them would mean every tray metric change
// re-placed a window.

import { create } from "zustand"
import { loggers } from "@cognia/logging"

import { getPref, setPref } from "@/lib/tauri/store"

import {
  DEFAULT_USAGE_DOCK_PREFERENCES,
  mergeDockPreferences,
  type UsageDockPreferencesV1,
} from "./types"

export const USAGE_DOCK_PREF = "usageDock.preferences.v1"

interface UsageDockStoreState {
  preferences: UsageDockPreferencesV1
  /** True once `hydrate` has resolved. First paint may still show defaults. */
  hydrated: boolean
  hydrate(): Promise<void>
  setPreferences(patch: Partial<UsageDockPreferencesV1>): void
  reset(): void
}

export const useUsageDockStore = create<UsageDockStoreState>((set, get) => ({
  preferences: DEFAULT_USAGE_DOCK_PREFERENCES,
  hydrated: false,

  async hydrate(): Promise<void> {
    try {
      const stored = await getPref<unknown>(USAGE_DOCK_PREF)
      set({ preferences: mergeDockPreferences(stored), hydrated: true })
    } catch (error) {
      // A missing or corrupt blob leaves the dock on its defaults, which are
      // "off". Failing closed is right here: the alternative is opening an
      // overlay window the user may never have asked for.
      loggers.tray?.warn?.("usage-dock: hydrate failed", { error: String(error) })
      set({ hydrated: true })
    }
  },

  setPreferences(patch: Partial<UsageDockPreferencesV1>): void {
    const next = mergeDockPreferences({ ...get().preferences, ...patch })
    set({ preferences: next })
    void setPref(USAGE_DOCK_PREF, next).catch((error: unknown) => {
      loggers.tray?.warn?.("usage-dock: persisting preferences failed", {
        error: String(error),
      })
    })
  },

  reset(): void {
    set({ preferences: DEFAULT_USAGE_DOCK_PREFERENCES })
    void setPref(USAGE_DOCK_PREF, DEFAULT_USAGE_DOCK_PREFERENCES).catch(() => {})
  },
}))

/** Test seam: drop the store back to its shipped defaults. */
export function __resetUsageDockStoreForTesting(): void {
  useUsageDockStore.setState({
    preferences: DEFAULT_USAGE_DOCK_PREFERENCES,
    hydrated: false,
  })
}
