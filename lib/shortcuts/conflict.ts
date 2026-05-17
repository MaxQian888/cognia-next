// Conflict detection for chord → id maps. Extracted from
// `stores/canvas/keybinding-store.ts:checkConflicts` so both the canvas
// keybinding UI and the unified shortcut panel use the same logic.
//
// A "conflict" is any normalized chord that maps to two or more ids. The
// returned record keys are the offending chords (normalized form); values
// are the ids competing for that chord. Single-id chords are omitted.

import { normalizeKeyCombo } from "./utils"
import type { Chord } from "./types"

export function findConflicts(bindings: Record<string, Chord>): Record<Chord, string[]> {
  const keyToIds: Record<string, string[]> = {}

  for (const [id, chord] of Object.entries(bindings)) {
    const normalized = normalizeKeyCombo(chord)
    if (!keyToIds[normalized]) keyToIds[normalized] = []
    keyToIds[normalized].push(id)
  }

  const conflicts: Record<string, string[]> = {}
  for (const [chord, ids] of Object.entries(keyToIds)) {
    if (ids.length > 1) conflicts[chord] = ids
  }
  return conflicts
}
