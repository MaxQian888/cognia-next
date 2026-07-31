// Renderer-side mirror of the Rust shortcut registry. Maintains a zustand
// store keyed by `id → chord`, exposes the conflict checker shared with
// the canvas keybinding panel, and provides `bind / unbind` actions that
// push through the matching IPC commands (`shortcut_bind` etc.).
//
// The Rust side is the OS-level authority for *dispatch* — but it keeps
// bindings only in process memory (see `src-tauri/src/shortcuts/registry.rs`
// module doc) and only re-seeds the 3 hardcoded built-in ids on boot
// (`seed_builtins`). Any other (custom) id a user binds would otherwise
// vanish on every restart, so this store additionally persists custom
// bindings to `cognia.store.json` (via `lib/tauri/store.ts`, the same file
// tray layout/autostart already use) and re-applies them during `hydrate()`.

"use client"

import { create } from "zustand"
import { invoke } from "@tauri-apps/api/core"
import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import { getPref, setPref } from "@/lib/tauri/store"

import { findConflicts } from "./conflict"
import { listGlobalShortcuts } from "./ipc"
import { normalizeKeyCombo } from "./utils"
import type { Chord, ShortcutBinding } from "./types"

/**
 * Ids the Rust side re-seeds itself on every boot (`seed_builtins`) — never
 * persist these through the custom-bindings pref, or a user override would
 * fight with the reseed on the next launch.
 */
const BUILT_IN_SHORTCUT_IDS = new Set(["tray.show", "tray.open-logs", "tray.automation-kill"])

const CUSTOM_SHORTCUTS_PREF_KEY = "shortcuts.custom.v1"

async function persistCustomBinding(id: string, chord: Chord): Promise<void> {
  if (BUILT_IN_SHORTCUT_IDS.has(id)) return
  const persisted = (await getPref<Record<string, Chord>>(CUSTOM_SHORTCUTS_PREF_KEY)) ?? {}
  await setPref(CUSTOM_SHORTCUTS_PREF_KEY, { ...persisted, [id]: chord })
}

async function forgetCustomBinding(id: string): Promise<void> {
  if (BUILT_IN_SHORTCUT_IDS.has(id)) return
  const persisted = (await getPref<Record<string, Chord>>(CUSTOM_SHORTCUTS_PREF_KEY)) ?? {}
  if (!(id in persisted)) return
  const rest = { ...persisted }
  delete rest[id]
  await setPref(CUSTOM_SHORTCUTS_PREF_KEY, rest)
}

interface ShortcutRegistryState {
  bindings: Record<string, Chord>
  conflicts: Record<Chord, string[]>
  hydrated: boolean

  hydrate(): Promise<void>
  bind(binding: ShortcutBinding): Promise<{ ok: boolean; error?: string }>
  unbind(id: string): Promise<void>
  conflictFor(chord: Chord, ignoringId?: string): Promise<string | null>
  /**
   * Resolve the current normalised chord for `id`. Returns the cached value
   * when the store has already hydrated; otherwise asks Rust directly via
   * `shortcut_get_chord_for_id`. Useful for diagnostic surfaces and the
   * settings UI's "current binding" label without forcing a full
   * `hydrate()` pass.
   */
  chordFor(id: string): Promise<Chord | null>
}

export const useShortcutStore = create<ShortcutRegistryState>((set, get) => ({
  bindings: {},
  conflicts: {},
  hydrated: false,

  async hydrate(): Promise<void> {
    if (!isTauri()) {
      set({ hydrated: true })
      return
    }
    try {
      const list = await listGlobalShortcuts()
      const bindings: Record<string, Chord> = {}
      for (const { id, chord } of list) {
        bindings[id] = chord
      }
      // Rust only re-seeds the 3 built-ins on boot — re-apply whatever custom
      // bindings the user saved last session before they're lost for good.
      const persisted = (await getPref<Record<string, Chord>>(CUSTOM_SHORTCUTS_PREF_KEY)) ?? {}
      for (const [id, chord] of Object.entries(persisted)) {
        if (bindings[id]) continue // Rust already reports this id — nothing to redo
        try {
          await invoke("shortcut_bind", { id, chord })
          bindings[id] = chord
        } catch (err) {
          loggers.tray.warn("failed to re-bind a persisted custom shortcut", {
            id,
            chord,
            error: String(err),
          })
        }
      }
      set({
        bindings,
        conflicts: findConflicts(bindings),
        hydrated: true,
      })
    } catch (err) {
      loggers.tray.warn("shortcut hydrate failed; using empty bindings", {
        error: String(err),
      })
      set({ hydrated: true })
    }
  },

  async bind({ id, chord }: ShortcutBinding): Promise<{ ok: boolean; error?: string }> {
    if (!isTauri()) return { ok: false, error: "not in tauri" }
    const normalized = normalizeKeyCombo(chord)
    try {
      await invoke("shortcut_bind", { id, chord: normalized })
      const next = { ...get().bindings, [id]: normalized }
      set({ bindings: next, conflicts: findConflicts(next) })
      await persistCustomBinding(id, normalized)
      return { ok: true }
    } catch (err) {
      const error = String(err)
      loggers.tray.warn("shortcut_bind failed", { id, chord: normalized, error })
      return { ok: false, error }
    }
  },

  async unbind(id: string): Promise<void> {
    if (!isTauri()) return
    try {
      await invoke("shortcut_unbind", { id })
      const next = { ...get().bindings }
      delete next[id]
      set({ bindings: next, conflicts: findConflicts(next) })
      await forgetCustomBinding(id)
    } catch (err) {
      loggers.tray.warn("shortcut_unbind failed", { id, error: String(err) })
    }
  },

  async conflictFor(chord: Chord, ignoringId?: string): Promise<string | null> {
    if (!isTauri()) return null
    try {
      const owner = await invoke<string | null>("shortcut_check_conflict", {
        chord: normalizeKeyCombo(chord),
        ignoringId,
      })
      return owner ?? null
    } catch (err) {
      loggers.tray.warn("shortcut_check_conflict failed", { chord, error: String(err) })
      return null
    }
  },

  async chordFor(id: string): Promise<Chord | null> {
    // Hydrated cache hit — return immediately without an IPC round-trip.
    // The store is the authority once hydrated; the Rust getter is for
    // pre-hydration callers and for diagnostic verification.
    const cached = get().bindings[id]
    if (cached) return cached
    if (!isTauri()) return null
    try {
      const chord = await invoke<string | null>("shortcut_get_chord_for_id", { id })
      return chord ?? null
    } catch (err) {
      loggers.tray.warn("shortcut_get_chord_for_id failed", { id, error: String(err) })
      return null
    }
  },
}))

/** Test-only escape hatch. */
export function __resetShortcutStoreForTesting(): void {
  useShortcutStore.setState({ bindings: {}, conflicts: {}, hydrated: false })
}
