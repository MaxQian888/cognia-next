// Persisted overrides for `app`-scope shortcuts (the renderer-wide keydown
// actions dispatched by `use-app-shortcut-dispatcher`). Only chords the user
// has *changed* are stored — a sparse `overrides` map keyed by shortcut id —
// so newly-shipped default chords are never shadowed by a stale full snapshot
// (contrast `stores/canvas/keybinding-store.ts`, which persists the full map).
//
// This store is the single writer for the `app` scope: the unified settings
// page and any per-feature dialog both go through `setOverride`/`resetOverride`,
// so a chord shown anywhere always matches the chord the dispatcher fires.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { normalizeKeyCombo } from "@/lib/shortcuts/utils"
import {
  APP_SHORTCUT_CATALOG,
  getAppShortcutDescriptor,
  getDefaultAcceptedChords,
} from "@/lib/shortcuts/app-catalog"
import type { Chord } from "@/lib/shortcuts/types"

interface AppKeybindingState {
  /** Sparse map of shortcut id → user override chord. Absent id ⇒ use default. */
  overrides: Record<string, Chord>

  /** Rebind `id` to `chord`. Empty string clears the shortcut (bound to nothing). */
  setOverride: (id: string, chord: Chord) => void
  /** Drop the override for `id`, restoring its catalog default. */
  resetOverride: (id: string) => void
  /** Drop every override, restoring all catalog defaults. */
  resetAll: () => void

  /** The effective *primary* chord for `id`: the override if any, else the default. */
  getChord: (id: string) => Chord
  /**
   * Every chord that should trigger `id`. When overridden it is exactly the
   * override; otherwise it is the default plus any catalog alt chords.
   */
  getAcceptedChords: (id: string) => Chord[]
  /** The shortcut id whose *primary* effective chord equals `chord`, if any. */
  getActionByChord: (chord: Chord) => string | undefined
  /** True when the user has overridden `id` away from its default. */
  isModified: (id: string) => boolean
}

export const useAppKeybindingStore = create<AppKeybindingState>()(
  persist(
    (set, get) => ({
      overrides: {},

      setOverride: (id, chord) => {
        const normalized = chord === "" ? "" : normalizeKeyCombo(chord)
        set((state) => ({ overrides: { ...state.overrides, [id]: normalized } }))
      },

      resetOverride: (id) => {
        set((state) => {
          if (!(id in state.overrides)) return state
          const next = { ...state.overrides }
          delete next[id]
          return { overrides: next }
        })
      },

      resetAll: () => set({ overrides: {} }),

      getChord: (id) => {
        const override = get().overrides[id]
        if (override !== undefined) return override
        return getAppShortcutDescriptor(id)?.defaultChord ?? ""
      },

      getAcceptedChords: (id) => {
        const override = get().overrides[id]
        if (override !== undefined) {
          return override === "" ? [] : [normalizeKeyCombo(override)]
        }
        return getDefaultAcceptedChords(id)
      },

      getActionByChord: (chord) => {
        const normalized = normalizeKeyCombo(chord)
        for (const descriptor of APP_SHORTCUT_CATALOG) {
          const effective = get().getChord(descriptor.id)
          if (effective !== "" && normalizeKeyCombo(effective) === normalized) {
            return descriptor.id
          }
        }
        return undefined
      },

      isModified: (id) => id in get().overrides,
    }),
    {
      name: "cognia-app-keybindings",
      partialize: (state) => ({ overrides: state.overrides }),
    }
  )
)

/** Test-only escape hatch. */
export function __resetAppKeybindingStoreForTesting(): void {
  useAppKeybindingStore.setState({ overrides: {} })
}

export default useAppKeybindingStore
