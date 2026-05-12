/**
 * Generic dynamic-overlay registry factory.
 *
 * Extracted from the §A-3 dynamic-overlay pattern originally landed in
 * `lib/ai/agent/external/presets.ts` (the runtime preset overlay). The
 * pattern lets plugins contribute entries into an in-memory Map at runtime
 * without mutating any closed/static union or breaking existing consumers.
 *
 * Design rules:
 *  - This factory intentionally has no static fallback. Callers compose
 *    `dynamic ⊕ static` themselves in their wrapper registry (the original
 *    presets module does this — `getPresetConfig` consults the static record
 *    first when no dynamic entry exists, then falls back the other way for
 *    shadowed ids).
 *  - The map is the only mutable state held by the closure; the factory is
 *    a true leaf module with no external imports.
 *  - Registration is idempotent: re-registering the same id replaces the
 *    previous entry. The previous entry is returned so callers can detect
 *    collisions.
 *  - Every entry carries an optional `pluginId` tag so the plugin manager
 *    can clean up all of one plugin's contributions in a single call via
 *    `unregisterByPlugin`.
 *
 * Consumers (M1·T3 of the plugin-first Computer Use plan):
 *  - `lib/plugin/registries/external-agent-preset-registry.ts`
 *  - `lib/plugin/registries/mcp-server-preset-registry.ts`
 *  - `lib/plugin/registries/native-anthropic-tool-registry.ts`
 *  - `lib/plugin/registries/skill-registry.ts`
 *
 * All four are one-line instantiations of this factory so they share one
 * tested implementation rather than each duplicating the same Map +
 * register/unregister boilerplate.
 */

export interface OverlayRegistry<T> {
  /**
   * Register an entry. Returns the previously registered entry (if any) so
   * callers can detect collisions. Re-registering the same id replaces the
   * previous entry — registration is idempotent.
   */
  register(
    id: string,
    entry: T,
    opts?: { pluginId?: string }
  ): { entry: T; pluginId?: string } | undefined

  /** Drop a single dynamic entry. Returns true if removed. */
  unregisterById(id: string): boolean

  /**
   * Drop every entry tagged with `pluginId`. Returns the number removed.
   * Called during plugin disable/uninstall to clean up all of a plugin's
   * contributions in one shot.
   */
  unregisterByPlugin(pluginId: string): number

  /** Get an entry by id. Returns undefined if not registered. */
  get(id: string): T | undefined

  /** Returns the full registry entry including pluginId tag. */
  getEntry(id: string): { entry: T; pluginId?: string } | undefined

  /** Returns all registered ids. */
  list(): string[]

  /** Returns every entry (id + value + pluginId) in registration order. */
  entries(): Array<{ id: string; entry: T; pluginId?: string }>

  /**
   * Test-only escape hatch: clear every dynamic entry so test isolation can
   * reset the overlay. Production code should never need this — use
   * `unregisterByPlugin` for normal cleanup.
   */
  __resetForTesting(): void
}

export interface CreateOverlayRegistryOptions {
  /** Optional registry name for diagnostics (used in error messages). */
  name?: string
}

interface InternalEntry<T> {
  entry: T
  pluginId?: string
}

/**
 * Create a new overlay registry instance. Each call produces an isolated
 * closure — two registries created by this factory share no state.
 */
export function createOverlayRegistry<T>(
  options?: CreateOverlayRegistryOptions
): OverlayRegistry<T> {
  // Map preserves insertion order, which `entries()` and `list()` rely on
  // so callers see registrations in the order they happened.
  const store = new Map<string, InternalEntry<T>>()
  // `name` is reserved for future diagnostics (e.g., richer error messages
  // when registering against a closed-union registry). It is intentionally
  // read but not used in this minimal implementation; touching `options`
  // here documents the contract without producing dead-import warnings.
  void options?.name

  return {
    register(id, entry, opts) {
      const previous = store.get(id)
      store.set(id, { entry, pluginId: opts?.pluginId })
      return previous
    },

    unregisterById(id) {
      return store.delete(id)
    },

    unregisterByPlugin(pluginId) {
      let removed = 0
      for (const [id, value] of store) {
        if (value.pluginId === pluginId) {
          store.delete(id)
          removed += 1
        }
      }
      return removed
    },

    get(id) {
      return store.get(id)?.entry
    },

    getEntry(id) {
      return store.get(id)
    },

    list() {
      return Array.from(store.keys())
    },

    entries() {
      return Array.from(store, ([id, value]) => ({
        id,
        entry: value.entry,
        pluginId: value.pluginId,
      }))
    },

    __resetForTesting() {
      store.clear()
    },
  }
}
