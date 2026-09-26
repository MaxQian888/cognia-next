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
import {
  evaluateContextWhen,
  useContextKeyStore,
  type ContextValue,
} from "@/lib/plugin/context-keys/context-key-store"
import { PINNED_NAV_SHORTCUT_IDS, getAppShortcutDescriptor } from "@/lib/shortcuts/app-catalog"
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

const NO_CONTEXT: Record<string, ContextValue> = {}

export interface AppShortcutLabelsOptions {
  /**
   * Print nothing for a chord whose descriptor's `when` clause is false in the
   * current context — it would not fire. Opt-in, because some web-only
   * descriptors (`shell.settings.open`) share their chord with a native menu
   * accelerator that does fire on Tauri, and their hint must stay.
   */
  activeOnly?: boolean
}

/**
 * {@link useAppShortcutLabel} for a list of ids at once — one store
 * subscription for the rail's nine pinned-slot chords rather than nine.
 * Pass a stable array (a module constant) so the result memoizes.
 */
export function useAppShortcutLabels(
  ids: readonly string[],
  { activeOnly = false }: AppShortcutLabelsOptions = {}
): AppShortcutLabel[] {
  const overrides = useAppKeybindingStore((s) => s.overrides)
  const context = useContextKeyStore((s) => (activeOnly ? s.keys : NO_CONTEXT))
  return useMemo(
    () =>
      ids.map((id) => {
        const descriptor = getAppShortcutDescriptor(id)
        if (activeOnly && !evaluateContextWhen(descriptor?.when, context)) return labelFor("")
        return labelFor(overrides[id] ?? descriptor?.defaultChord ?? "")
      }),
    [ids, overrides, activeOnly, context]
  )
}

const PINNED_OPTIONS: AppShortcutLabelsOptions = { activeOnly: true }

/**
 * The nine pinned-slot chords (⌥1…⌥9) as the rail and the sidebar's hosted
 * nav rows print them — blank where the slot's shortcut cannot fire here
 * (a browser on Linux; see the descriptors in `app-catalog.ts`).
 */
export function usePinnedNavShortcutLabels(): AppShortcutLabel[] {
  return useAppShortcutLabels(PINNED_NAV_SHORTCUT_IDS, PINNED_OPTIONS)
}
