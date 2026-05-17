// Renderer-side mirror of the Rust shortcut registry. Maintains a zustand
// store keyed by `id → chord`, exposes the conflict checker shared with
// the canvas keybinding panel, and provides `bind / unbind` actions that
// push through the matching IPC commands (`shortcut_bind` etc.).
//
// The Rust side is the OS-level authority — this store mirrors what was
// most recently confirmed by the IPC round-trip.

"use client"

import { create } from "zustand"
import { invoke } from "@tauri-apps/api/core"
import { loggers } from "@/lib/logger"
import { isTauri } from "@/lib/tauri"

import { findConflicts } from "./conflict"
import { normalizeKeyCombo } from "./utils"
import type { Chord, ShortcutBinding } from "./types"

interface ShortcutRegistryState {
  bindings: Record<string, Chord>
  conflicts: Record<Chord, string[]>
  hydrated: boolean

  hydrate(): Promise<void>
  bind(binding: ShortcutBinding): Promise<{ ok: boolean; error?: string }>
  unbind(id: string): Promise<void>
  conflictFor(chord: Chord, ignoringId?: string): Promise<string | null>
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
      const list = await invoke<Array<{ id: string; chord: string }>>("shortcut_list")
      const bindings: Record<string, Chord> = {}
      for (const { id, chord } of list ?? []) {
        bindings[id] = chord
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
}))

/** Test-only escape hatch. */
export function __resetShortcutStoreForTesting(): void {
  useShortcutStore.setState({ bindings: {}, conflicts: {}, hydrated: false })
}
