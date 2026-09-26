"use client"

// The chord an `app`-scope shortcut is bound to *right now*, for display.
//
// Anything that prints a shortcut — a tooltip, a menu row's hint, an
// `aria-keyshortcuts` — has to print the chord the dispatcher will actually
// fire, which is the user's override when there is one. Hard-coding the
// default (`⌘,` in the account menu used to be exactly that) goes stale the
// moment someone rebinds it, and prints a Mac glyph on Windows and Linux.

import { useMemo } from "react"

import { useAppKeybindingStore } from "@/stores/shortcuts/app-keybinding-store"
import { getAppShortcutDescriptor } from "@/lib/shortcuts/app-catalog"
import { formatKeybinding, toAriaKeyShortcuts } from "@/lib/shortcuts/utils"
import type { Chord } from "@/lib/shortcuts/types"

/** The effective primary chord for `id` (override, else default); `""` when unbound. */
export function useAppShortcutChord(id: string): Chord {
  const override = useAppKeybindingStore((s) => s.overrides[id])
  return override ?? getAppShortcutDescriptor(id)?.defaultChord ?? ""
}

export interface AppShortcutLabel {
  /** Platform-formatted chord (`⌘,` / `Ctrl+,`), or `""` when unbound. */
  label: string
  /** The same chord for `aria-keyshortcuts`, or `undefined` when unbound. */
  aria: string | undefined
}

function labelFor(chord: Chord): AppShortcutLabel {
  return { label: chord ? formatKeybinding(chord) : "", aria: toAriaKeyShortcuts(chord) }
}

export function useAppShortcutLabel(id: string): AppShortcutLabel {
  return labelFor(useAppShortcutChord(id))
}

/**
 * {@link useAppShortcutLabel} for a list of ids at once — one store
 * subscription for the rail's nine pinned-slot chords rather than nine.
 * Pass a stable array (a module constant) so the result memoizes.
 */
export function useAppShortcutLabels(ids: readonly string[]): AppShortcutLabel[] {
  const overrides = useAppKeybindingStore((s) => s.overrides)
  return useMemo(
    () =>
      ids.map((id) => labelFor(overrides[id] ?? getAppShortcutDescriptor(id)?.defaultChord ?? "")),
    [ids, overrides]
  )
}
