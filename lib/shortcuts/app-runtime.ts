// In-memory registry of live `app`-scope shortcut handlers. A feature mounts a
// handler via `useAppShortcut`; the single `use-app-shortcut-dispatcher` reads
// this registry on every keydown. Mount-scoping is the guard: a handler only
// exists while its panel is mounted, so "only when X is focused/open" falls out
// for free. This module is framework-agnostic (no React) so it unit-tests in
// node.

import type { Chord } from "./types"

export interface AppShortcutRegistration {
  /** Shortcut id — also the catalog key and, unless `commandId` overrides, the plugin dispatch id. */
  id: string
  /** Fired when a matching chord is pressed and all guards pass. */
  handler: (event: KeyboardEvent) => void
  /** When-clause gating activation; evaluated by the dispatcher. */
  when?: string
  /** Allow firing even while an editable control is focused. Defaults to false. */
  allowInEditable?: boolean
  /** Call `event.preventDefault()` before the handler runs. */
  preventDefault?: boolean
  /** Editor surfaces whose descendants also count as editable (Monaco, CodeMirror). */
  editorSelectors?: string[]
  /** Plugin/command dispatch id; defaults to `id`. */
  commandId?: string
}

/** Resolves the set of chords currently accepted for a shortcut id (store-aware). */
export type AcceptedChordResolver = (id: string) => Chord[]

const registrations = new Map<string, AppShortcutRegistration>()

/**
 * Register a live handler. Later registrations for the same id replace earlier
 * ones (last mount wins). Returns a disposer that removes *this* registration
 * only if it is still the active one — so an unmount cannot clobber a remount.
 */
export function registerAppShortcut(registration: AppShortcutRegistration): () => void {
  registrations.set(registration.id, registration)
  return () => {
    if (registrations.get(registration.id) === registration) {
      registrations.delete(registration.id)
    }
  }
}

/** The live registration for `id`, if any. */
export function getAppRegistration(id: string): AppShortcutRegistration | undefined {
  return registrations.get(id)
}

/** All live registrations, in registration order. */
export function listAppRegistrations(): AppShortcutRegistration[] {
  return [...registrations.values()]
}

/**
 * Registrations whose current accepted chords include `normalizedChord`, in
 * registration order. The dispatcher then applies editable / when guards and
 * fires the first survivor (first-match-wins ⇒ no double-fire).
 */
export function matchingAppShortcuts(
  normalizedChord: Chord,
  resolveAcceptedChords: AcceptedChordResolver
): AppShortcutRegistration[] {
  const hits: AppShortcutRegistration[] = []
  for (const registration of registrations.values()) {
    if (resolveAcceptedChords(registration.id).includes(normalizedChord)) {
      hits.push(registration)
    }
  }
  return hits
}

/** Test-only: drop every registration. */
export function __resetAppRuntimeForTesting(): void {
  registrations.clear()
}
