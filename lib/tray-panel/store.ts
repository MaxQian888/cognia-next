// Zustand store holding the user's tray-panel action catalogue.
//
// Persistence rides on `lib/tauri/store.ts` (the Tauri Store plugin) rather
// than Dexie, for the same reason the tray menu's layout does: both the panel
// window and the main window need it, and the panel is a least-privilege
// webview that must not carry the whole Dexie schema. The store file is shared
// across windows, so a change made in settings is visible to the panel on its
// next hydrate.

"use client"

import { create } from "zustand"
import { loggers } from "@cognia/logging"
import { getPref, setPref } from "@/lib/tauri/store"

import {
  DEFAULT_TRAY_PANEL_ACTIONS,
  TRAY_PANEL_ACTIONS_PREF,
  ensureBuiltInActions,
} from "./defaults"
import type { TrayPanelAction } from "./types"

interface TrayPanelState {
  actions: TrayPanelAction[]
  /** True once `hydrate` has resolved — first paint may still be defaults. */
  hydrated: boolean

  hydrate(): Promise<void>
  setActions(next: TrayPanelAction[]): void
  upsertAction(action: TrayPanelAction): void
  removeAction(id: string): void
  moveAction(id: string, direction: -1 | 1): void
  reset(): void
}

/** Swap `index` with its neighbour in `direction`; a no-op at the ends. */
export function reorderActions(
  actions: readonly TrayPanelAction[],
  index: number,
  direction: -1 | 1
): TrayPanelAction[] {
  const target = index + direction
  if (index < 0 || index >= actions.length) return actions.slice()
  if (target < 0 || target >= actions.length) return actions.slice()
  const next = actions.slice()
  const tmp = next[index]
  next[index] = next[target]
  next[target] = tmp
  return next
}

export const useTrayPanelStore = create<TrayPanelState>((set, get) => ({
  actions: DEFAULT_TRAY_PANEL_ACTIONS,
  hydrated: false,

  async hydrate(): Promise<void> {
    try {
      const stored = await getPref<TrayPanelAction[]>(TRAY_PANEL_ACTIONS_PREF)
      set({
        actions: stored?.length ? ensureBuiltInActions(stored) : DEFAULT_TRAY_PANEL_ACTIONS,
        hydrated: true,
      })
    } catch (err) {
      loggers.tray.warn("tray panel hydrate failed; using defaults", { error: String(err) })
      set({ hydrated: true })
    }
  },

  setActions(next: TrayPanelAction[]): void {
    set({ actions: next })
    void setPref(TRAY_PANEL_ACTIONS_PREF, next)
  },

  upsertAction(action: TrayPanelAction): void {
    const current = get().actions
    const index = current.findIndex((a) => a.id === action.id)
    const next = index >= 0 ? current.slice() : [...current, action]
    if (index >= 0) next[index] = action
    get().setActions(next)
  },

  removeAction(id: string): void {
    // Built-ins are never removed, only hidden: their ids are referenced by
    // the shipped defaults, so a delete would be undone by the next
    // `ensureBuiltInActions` backfill and read as "it came back on its own".
    const next = get().actions.map((a) => (a.id === id && a.builtIn ? { ...a, hidden: true } : a))
    get().setActions(next.filter((a) => a.id !== id || a.builtIn))
  },

  moveAction(id: string, direction: -1 | 1): void {
    const current = get().actions
    const index = current.findIndex((a) => a.id === id)
    if (index < 0) return
    get().setActions(reorderActions(current, index, direction))
  },

  reset(): void {
    get().setActions(DEFAULT_TRAY_PANEL_ACTIONS)
  },
}))

/**
 * Test-only escape hatch — restores the pristine module state. Mirrors
 * `lib/tray/store.ts:__resetTrayStoreForTesting`; the store is a module
 * singleton, so without this one suite's edits leak into the next.
 */
export function __resetTrayPanelStoreForTesting(): void {
  useTrayPanelStore.setState({ actions: DEFAULT_TRAY_PANEL_ACTIONS, hydrated: false })
}
