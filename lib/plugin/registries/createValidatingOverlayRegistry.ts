/**
 * Validating overlay registry factory.
 *
 * Three registries — character-pack, agent-team-template and
 * workflow-template — each layered the same ~70-line "register + stamp
 * non-blocking `requires` warnings" pattern on top of a bare
 * `createOverlayRegistry`: a sidecar `warningsBy*Id` map, a `register*`
 * wrapper that validates on insert, a `refreshAll*Warnings` re-validation
 * sweep, `unregister*` variants that drop warnings alongside entries, and a
 * `get*Warnings` reader. This factory hoists that shared shape so the three
 * registries keep only their bespoke validation logic and convenience views.
 *
 * Warnings are non-blocking: the entry is always registered; consumers read
 * `getWarnings(id)` (which returns an empty array, never undefined) and
 * surface chips on the affected rows. The warning surface is held in a
 * sidecar map — separate from the overlay registry's own Map — so
 * `refreshAllWarnings` can clear/recompute a warning (e.g. once a missing
 * dependency arrives) without touching the registered entry.
 */

import { createOverlayRegistry } from "./createOverlayRegistry"

export interface ValidatingOverlayRegistry<T, W> {
  /**
   * Register an entry and stamp its `requires` warnings. Returns the
   * previously registered entry (if any), matching `OverlayRegistry.register`.
   */
  register(
    id: string,
    entry: T,
    opts?: { pluginId?: string }
  ): { entry: T; pluginId?: string; meta?: Record<string, unknown> } | undefined
  /** Re-run validation for every registered entry. */
  refreshAllWarnings(): void
  /** Drop a single entry (and its warnings) by id. */
  unregisterById(id: string): boolean
  /** Drop every entry (and its warnings) contributed by `pluginId`. */
  unregisterByPlugin(pluginId: string): number
  /** Warnings collected for an entry — empty array (never undefined) when clean. */
  getWarnings(id: string): readonly W[]
  /** Get an entry by id. */
  get(id: string): T | undefined
  /** Get the full registry entry (value + pluginId tag) for an id. */
  getEntry(id: string): { entry: T; pluginId?: string; meta?: Record<string, unknown> } | undefined
  /** Every registered id in registration order. */
  list(): string[]
  /** Every registered entry (id + value + pluginId) in registration order. */
  entries(): Array<{ id: string; entry: T; pluginId?: string; meta?: Record<string, unknown> }>
  /** Test-only: clear every entry and its warnings. */
  __resetForTesting(): void
}

export interface CreateValidatingOverlayRegistryOptions<T, W> {
  /** Optional registry name for diagnostics. */
  name?: string
  /**
   * Compute the non-blocking warnings for an entry. Returning an empty array
   * clears any previously stamped warnings for that id.
   */
  validate: (entry: T) => readonly W[]
}

export function createValidatingOverlayRegistry<T, W>(
  options: CreateValidatingOverlayRegistryOptions<T, W>
): ValidatingOverlayRegistry<T, W> {
  const registry = createOverlayRegistry<T>({ name: options.name })
  const warningsById = new Map<string, readonly W[]>()

  // Recompute and (re)stamp warnings for one entry. Empty result drops the
  // sidecar entry so `getWarnings` returns the clean empty-array default.
  function stamp(id: string, entry: T): void {
    const warnings = options.validate(entry)
    if (warnings.length > 0) {
      warningsById.set(id, Object.freeze(warnings))
    } else {
      warningsById.delete(id)
    }
  }

  return {
    register(id, entry, opts) {
      const previous = registry.register(id, entry, opts)
      stamp(id, entry)
      return previous
    },

    refreshAllWarnings() {
      for (const { id, entry } of registry.entries()) {
        stamp(id, entry)
      }
    },

    unregisterById(id) {
      warningsById.delete(id)
      return registry.unregisterById(id)
    },

    unregisterByPlugin(pluginId) {
      for (const { id, pluginId: tag } of registry.entries()) {
        if (tag === pluginId) warningsById.delete(id)
      }
      return registry.unregisterByPlugin(pluginId)
    },

    getWarnings(id) {
      return warningsById.get(id) ?? []
    },

    get: registry.get,
    getEntry: registry.getEntry,
    list: registry.list,
    entries: registry.entries,

    __resetForTesting() {
      warningsById.clear()
      registry.__resetForTesting()
    },
  }
}
