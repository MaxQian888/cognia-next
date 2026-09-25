// Zustand store holding the user's customised tray layout + tooltip in
// memory. Persistence rides on `lib/tauri/store.ts:1-66` (Tauri Store
// plugin) so the layout survives restarts in the same `cognia.store.json`
// file as `exit.close-behavior`.
//
// `useTrayStore` is the renderer's source of truth; `lib/tray/sync.ts`
// observes it (plus the state snapshots referenced by `when` expressions)
// and pushes a fresh DTO to Rust via `tray_set_menu`.

"use client"

import { create } from "zustand"
import { loggers } from "@cognia/logging"
import { getPref, setPref } from "@/lib/tauri/store"

import {
  DEFAULT_TRAY_DISPLAY,
  DEFAULT_TRAY_ITEMS,
  TRAY_DISPLAY_PREF,
  TRAY_LAYOUT_PREF,
  TRAY_TOOLTIP_PREF,
} from "./defaults"
import { retiredNativeReplacement } from "./native-actions"
import type { TrayDisplayPrefs, TrayIconState, TrayMenuItem } from "./types"

interface TrayState {
  /** The user's full menu layout. Replaces wholesale on save. */
  items: TrayMenuItem[]
  /** Current icon variant — set by `sync.ts` in response to app-state changes. */
  iconState: TrayIconState
  /** OS-level tooltip. Defaults to "Cognia". */
  tooltip: string
  /** Display preferences (usage surfaces, taskbar mode, icon color, …). */
  display: TrayDisplayPrefs
  /** True once `hydrate` has resolved (first paint may still be the defaults). */
  hydrated: boolean

  hydrate(): Promise<void>
  setItems(next: TrayMenuItem[]): void
  setIconState(state: TrayIconState): void
  setTooltip(text: string): void
  setDisplay(patch: Partial<TrayDisplayPrefs>): void
  reset(): void
}

/**
 * Layouts persisted before a synthetic placeholder shipped lack its entry, so
 * the new section would silently never render for existing users. Insert any
 * missing placeholder at the position it holds in `DEFAULT_TRAY_ITEMS`
 * (clamped), preserving everything the user customised.
 */
export function ensureSyntheticEntries(stored: TrayMenuItem[]): TrayMenuItem[] {
  // Only placeholders the builder expands are backfilled — plain actions were
  // offered to the user before, so their absence means an explicit removal.
  const BACKFILL_IDS = ["tray.usage"]
  let out = stored
  for (const id of BACKFILL_IDS) {
    if (out.some((it) => "id" in it && it.id === id)) continue
    const defIdx = DEFAULT_TRAY_ITEMS.findIndex((it) => "id" in it && it.id === id)
    const def = DEFAULT_TRAY_ITEMS[defIdx]
    if (!def) continue
    out = out.slice()
    out.splice(Math.min(defIdx, out.length), 0, def)
  }
  return out
}

/**
 * Rewrite payloads that name a retired native action into the command that
 * replaced it (`RETIRED_NATIVE_TRAY_ACTIONS`), recursing into submenus.
 *
 * The layout persists whole payloads, so without this a layout saved before a
 * native action was retired would keep naming it, and the Rust menu builder
 * rejects a push with an unknown native action outright: the user's whole
 * tray would stop updating. Returns the same array reference when nothing
 * changed, like {@link ensureSyntheticEntries}, and writes nothing back: the
 * next `setItems` persists the migrated shape, and until then every hydrate
 * migrates it again, which is idempotent.
 */
export function migrateRetiredNativePayloads(stored: TrayMenuItem[]): TrayMenuItem[] {
  let changed = false
  const out = stored.map((item): TrayMenuItem => {
    if (item.kind === "submenu") {
      const items = migrateRetiredNativePayloads(item.items)
      if (items === item.items) return item
      changed = true
      return { ...item, items }
    }
    if (item.kind !== "action" || item.payload.kind !== "native") return item
    const commandId = retiredNativeReplacement(item.payload.action)
    if (!commandId) return item
    changed = true
    return { ...item, payload: { kind: "command", commandId } }
  })
  return changed ? out : stored
}

/** Merge a stored (possibly partial / stale-shaped) prefs blob over defaults. */
function mergeDisplay(stored: Partial<TrayDisplayPrefs> | null | undefined): TrayDisplayPrefs {
  return { ...DEFAULT_TRAY_DISPLAY, ...(stored ?? {}) }
}

export const useTrayStore = create<TrayState>((set, get) => ({
  items: DEFAULT_TRAY_ITEMS,
  iconState: "idle",
  tooltip: "Cognia",
  display: DEFAULT_TRAY_DISPLAY,
  hydrated: false,

  async hydrate(): Promise<void> {
    try {
      const [storedItems, storedTooltip, storedDisplay] = await Promise.all([
        getPref<TrayMenuItem[]>(TRAY_LAYOUT_PREF),
        getPref<string>(TRAY_TOOLTIP_PREF),
        getPref<Partial<TrayDisplayPrefs>>(TRAY_DISPLAY_PREF),
      ])
      set({
        items: storedItems?.length
          ? ensureSyntheticEntries(migrateRetiredNativePayloads(storedItems))
          : DEFAULT_TRAY_ITEMS,
        tooltip: storedTooltip ?? "Cognia",
        display: mergeDisplay(storedDisplay),
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

  setDisplay(patch: Partial<TrayDisplayPrefs>): void {
    const next = { ...get().display, ...patch }
    set({ display: next })
    void setPref(TRAY_DISPLAY_PREF, next)
  },

  reset(): void {
    set({ items: DEFAULT_TRAY_ITEMS, tooltip: "Cognia", display: DEFAULT_TRAY_DISPLAY })
    void setPref(TRAY_LAYOUT_PREF, DEFAULT_TRAY_ITEMS)
    void setPref(TRAY_TOOLTIP_PREF, "Cognia")
    void setPref(TRAY_DISPLAY_PREF, DEFAULT_TRAY_DISPLAY)
  },
}))

/** Test-only escape hatch — resets the store to its initial shape. */
export function __resetTrayStoreForTesting(): void {
  useTrayStore.setState({
    items: DEFAULT_TRAY_ITEMS,
    iconState: "idle",
    tooltip: "Cognia",
    display: DEFAULT_TRAY_DISPLAY,
    hydrated: false,
  })
}
