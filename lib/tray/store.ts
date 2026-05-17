// Zustand store holding the user's customised tray layout + tooltip in
// memory. Persistence rides on `lib/tauri/store.ts:1-66` (Tauri Store
// plugin) so the layout survives restarts in the same `cognia.store.json`
// file as `tray.minimize-on-close`.
//
// `useTrayStore` is the renderer's source of truth; `lib/tray/sync.ts`
// observes it (plus the state snapshots referenced by `when` expressions)
// and pushes a fresh DTO to Rust via `tray_set_menu`.

"use client"

import { create } from "zustand"
import { loggers } from "@/lib/logger"
import { getPref, setPref } from "@/lib/tauri/store"

import { DEFAULT_TRAY_ITEMS, TRAY_LAYOUT_PREF, TRAY_TOOLTIP_PREF } from "./defaults"
import type { TrayIconState, TrayMenuItem } from "./types"

interface TrayState {
  /** The user's full menu layout. Replaces wholesale on save. */
  items: TrayMenuItem[]
  /** Current icon variant — set by `sync.ts` in response to app-state changes. */
  iconState: TrayIconState
  /** OS-level tooltip. Defaults to "Cognia". */
  tooltip: string
  /** True once `hydrate` has resolved (first paint may still be the defaults). */
  hydrated: boolean

  hydrate(): Promise<void>
  setItems(next: TrayMenuItem[]): void
  setIconState(state: TrayIconState): void
  setTooltip(text: string): void
  reset(): void
}

export const useTrayStore = create<TrayState>((set, get) => ({
  items: DEFAULT_TRAY_ITEMS,
  iconState: "idle",
  tooltip: "Cognia",
  hydrated: false,

  async hydrate(): Promise<void> {
    try {
      const [storedItems, storedTooltip] = await Promise.all([
        getPref<TrayMenuItem[]>(TRAY_LAYOUT_PREF),
        getPref<string>(TRAY_TOOLTIP_PREF),
      ])
      set({
        items: storedItems?.length ? storedItems : DEFAULT_TRAY_ITEMS,
        tooltip: storedTooltip ?? "Cognia",
        hydrated: true,
      })
    } catch (err) {
      loggers.tray.warn("tray hydrate failed; using defaults", { error: String(err) })
      set({ hydrated: true })
    }
  },

  setItems(next: TrayMenuItem[]): void {
    set({ items: next })
    void setPref(TRAY_LAYOUT_PREF, next)
  },

  setIconState(state: TrayIconState): void {
    if (get().iconState === state) return
    set({ iconState: state })
  },

  setTooltip(text: string): void {
    set({ tooltip: text })
    void setPref(TRAY_TOOLTIP_PREF, text)
  },

  reset(): void {
    set({ items: DEFAULT_TRAY_ITEMS, tooltip: "Cognia" })
    void setPref(TRAY_LAYOUT_PREF, DEFAULT_TRAY_ITEMS)
    void setPref(TRAY_TOOLTIP_PREF, "Cognia")
  },
}))

/** Test-only escape hatch — resets the store to its initial shape. */
export function __resetTrayStoreForTesting(): void {
  useTrayStore.setState({
    items: DEFAULT_TRAY_ITEMS,
    iconState: "idle",
    tooltip: "Cognia",
    hydrated: false,
  })
}
