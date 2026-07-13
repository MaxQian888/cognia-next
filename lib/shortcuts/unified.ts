"use client"

// Read-only projection + write facade over the app-scope shortcut store for the
// unified settings page. Global + editor scopes keep their own existing UIs
// (ShortcutsSection / KeybindingSettings); this module owns the "App" group:
// grouped rows with their live chords, plus a scope-aware conflict check used by
// the recorder. Every write still goes through the single app-keybinding store,
// so the page and any feature dialog stay in sync.

import { APP_SHORTCUT_CATALOG } from "./app-catalog"
import { normalizeKeyCombo } from "./utils"
import type { Chord, ShortcutDescriptor } from "./types"
import { useAppKeybindingStore } from "@/stores/shortcuts/app-keybinding-store"

export interface AppShortcutRow {
  descriptor: ShortcutDescriptor
  /** Effective chord (override or default). */
  chord: Chord
  /** True when the user has overridden this shortcut away from its default. */
  isModified: boolean
}

export interface AppShortcutGroup {
  category: string
  rows: AppShortcutRow[]
}

/** True when two `when` clauses are exact negations (`x` vs `!x`) — mutually exclusive contexts. */
function whensAreExclusive(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return a === `!${b}` || b === `!${a}`
}

/**
 * The id of another editable app shortcut whose effective chord collides with
 * `chord`, or null. Two shortcuts do NOT collide when their `when` clauses are
 * exact negations (e.g. `view.canvas` vs `!view.canvas`) — they can never be
 * active at the same time.
 */
export function findAppConflict(
  chord: Chord,
  ignoringId: string,
  getChord: (id: string) => Chord = (id) => useAppKeybindingStore.getState().getChord(id)
): string | null {
  if (chord === "") return null
  const normalized = normalizeKeyCombo(chord)
  const source = APP_SHORTCUT_CATALOG.find((d) => d.id === ignoringId)
  for (const descriptor of APP_SHORTCUT_CATALOG) {
    if (descriptor.id === ignoringId) continue
    if (descriptor.editable === false) continue
    const other = getChord(descriptor.id)
    if (other === "" || normalizeKeyCombo(other) !== normalized) continue
    if (whensAreExclusive(source?.when, descriptor.when)) continue
    return descriptor.id
  }
  return null
}

/** All editable app-scope shortcuts, grouped by category, with their live chords. */
export function getAppShortcutGroups(
  getChord: (id: string) => Chord = (id) => useAppKeybindingStore.getState().getChord(id),
  isModified: (id: string) => boolean = (id) => useAppKeybindingStore.getState().isModified(id)
): AppShortcutGroup[] {
  const byCategory = new Map<string, AppShortcutRow[]>()
  for (const descriptor of APP_SHORTCUT_CATALOG) {
    if (descriptor.editable === false) continue
    const row: AppShortcutRow = {
      descriptor,
      chord: getChord(descriptor.id),
      isModified: isModified(descriptor.id),
    }
    const existing = byCategory.get(descriptor.category)
    if (existing) existing.push(row)
    else byCategory.set(descriptor.category, [row])
  }
  return [...byCategory.entries()].map(([category, rows]) => ({ category, rows }))
}

/** Rebind an app shortcut (empty string clears it). Delegates to the single store. */
export function rebindAppShortcut(id: string, chord: Chord): void {
  useAppKeybindingStore.getState().setOverride(id, chord)
}

/** Restore an app shortcut to its catalog default. */
export function resetAppShortcut(id: string): void {
  useAppKeybindingStore.getState().resetOverride(id)
}
