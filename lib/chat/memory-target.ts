// Where a composer `#` capture should be written.
//
// The repo has TWO unrelated types both named `MemoryScope`:
//   - `lib/files/memory.ts`         → "project" | "user"  (a line appended to a
//                                      CLAUDE.md file; desktop-only)
//   - `packages/memory/.../memory`  → "global" | "workspace" | "character" |
//                                      "agent"  (the ADR-0069 learned-memory
//                                      store, all platforms)
//
// They are not interchangeable, so this module models the choice as a
// discriminated union rather than flattening both into one string union — which
// would let a file scope be passed to the store write and vice versa.

import type { MemoryScope as FileMemoryScope } from "@/lib/files/memory"
import type { MemoryScope as StoreMemoryScope } from "@/types/memory/memory"

/** Long-term-store scopes the `#` picker offers. The remaining store scopes
 * (`character`, `agent`) are derived from session context, never picked by
 * hand, so they are deliberately absent here. */
export type PickableStoreScope = Extract<StoreMemoryScope, "global" | "workspace">

export type ComposerMemoryTarget =
  { target: "file"; scope: FileMemoryScope } | { target: "store"; scope: PickableStoreScope }

/** The four rows the `#` popover offers, in display order. */
export const COMPOSER_MEMORY_TARGETS: readonly ComposerMemoryTarget[] = [
  { target: "store", scope: "global" },
  { target: "store", scope: "workspace" },
  { target: "file", scope: "project" },
  { target: "file", scope: "user" },
]

/** Stable key for React lists, persistence and equality checks. */
export function memoryTargetKey(target: ComposerMemoryTarget): string {
  return `${target.target}:${target.scope}`
}

/**
 * Parse a {@link memoryTargetKey} back into a target. Returns null for anything
 * unrecognised, so a stale persisted value degrades to "ask the user" rather
 * than writing to the wrong place.
 */
export function parseMemoryTargetKey(key: string | null | undefined): ComposerMemoryTarget | null {
  if (!key) return null
  return COMPOSER_MEMORY_TARGETS.find((t) => memoryTargetKey(t) === key) ?? null
}

/**
 * File-scoped writes go through the Tauri `memory_append` command, so they are
 * unavailable in the browser and on mobile. Store writes work everywhere.
 */
export function isMemoryTargetAvailable(target: ComposerMemoryTarget, isDesktop: boolean): boolean {
  return target.target === "store" || isDesktop
}
