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
 *  - Registration is idempotent under the default `last-wins` policy:
 *    re-registering the same key replaces the previous entry. The previous
 *    entry is returned so callers can detect collisions.
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
 * register/unregister boilerplate. The optional `keyFn` / `conflictPolicy` /
 * `onConflict` / `metadata` options additionally let the host's bespoke
 * `PluginRegistry` (tools/components/modes/commands/templates) ride the same
 * factory instead of a hand-rolled Map.
 */

export interface OverlayRegistry<T> {
  /**
   * Register an entry. Returns the previously registered entry (if any) so
   * callers can detect collisions.
   *
   * Conflict behaviour depends on `conflictPolicy` (factory option):
   *  - `"last-wins"` (default): re-registering the same key replaces the
   *    previous entry — registration is idempotent.
   *  - `"first-wins-cross-plugin"`: a key already held by a *different*
   *    pluginId is NOT overwritten (the incumbent wins); `onConflict` fires
   *    and the incumbent is returned. A re-register by the *same* pluginId
   *    still refreshes (so hot-reload / snapshot-restore keep working).
   *
   * When a `keyFn` is configured, the storage key is `keyFn(id, entry, opts)`;
   * `get` / `getEntry` / `unregisterById` then expect that derived key.
   */
  register(
    id: string,
    entry: T,
    opts?: { pluginId?: string }
  ): { entry: T; pluginId?: string; meta?: Record<string, unknown> } | undefined

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
  getEntry(id: string): { entry: T; pluginId?: string; meta?: Record<string, unknown> } | undefined

  /** Returns all registered ids. */
  list(): string[]

  /** Returns every entry (id + value + pluginId) in registration order. */
  entries(): Array<{ id: string; entry: T; pluginId?: string; meta?: Record<string, unknown> }>

  /**
   * Test-only escape hatch: clear every dynamic entry so test isolation can
   * reset the overlay. Production code should never need this — use
   * `unregisterByPlugin` for normal cleanup.
   */
  __resetForTesting(): void
}

/** Information passed to `onConflict` when a registration is rejected. */
export interface OverlayConflictInfo {
  /** Registry name (the `name` option), for diagnostics. */
  name?: string
  /** The storage key that collided. */
  key: string
  /** pluginId that already holds the key (the winner). */
  existingPluginId?: string
  /** pluginId whose registration was rejected. */
  incomingPluginId?: string
}

export interface CreateOverlayRegistryOptions<T> {
  /** Optional registry name for diagnostics (used in error messages). */
  name?: string
  /**
   * Derive the storage key from the registration arguments. Defaults to the
   * `id` verbatim. Lets one factory model the per-domain keying the old
   * bespoke `PluginRegistry` used (e.g. templates key by
   * `${pluginId}:${id}`). `get` / `getEntry` / `unregisterById` expect the
   * derived key, so callers that configure a non-identity `keyFn` must look
   * up by the same derived key.
   */
  keyFn?: (id: string, entry: T, opts?: { pluginId?: string }) => string
  /**
   * Collision resolution. Defaults to `"last-wins"` (preserves the original
   * overlay-registry semantics). `"first-wins-cross-plugin"` keeps the
   * incumbent when a *different* plugin re-uses a key, but still lets the
   * *same* plugin refresh its own entry.
   */
  conflictPolicy?: "last-wins" | "first-wins-cross-plugin"
  /**
   * Invoked when `first-wins-cross-plugin` rejects an incoming registration.
   * Injected (not imported) so this stays a leaf module with no logger/
   * diagnostics dependency — wrappers pass their own reporter.
   */
  onConflict?: (info: OverlayConflictInfo) => void
  /**
   * Optional metadata stamped onto each stored entry (e.g. `registeredAt`).
   * Surfaced on `getEntry` / `entries` as `meta`.
   */
  metadata?: (entry: T, opts?: { pluginId?: string }) => Record<string, unknown>
}

interface InternalEntry<T> {
  entry: T
  pluginId?: string
  meta?: Record<string, unknown>
}

/**
 * Create a new overlay registry instance. Each call produces an isolated
 * closure — two registries created by this factory share no state.
 */
export function createOverlayRegistry<T>(
  options?: CreateOverlayRegistryOptions<T>
): OverlayRegistry<T> {
  // Map preserves insertion order, which `entries()` and `list()` rely on
  // so callers see registrations in the order they happened.
  const store = new Map<string, InternalEntry<T>>()
  const keyFn = options?.keyFn
  const conflictPolicy = options?.conflictPolicy ?? "last-wins"
  const onConflict = options?.onConflict
  const metadata = options?.metadata

  return {
    register(id, entry, opts) {
      const key = keyFn ? keyFn(id, entry, opts) : id
      const previous = store.get(key)

      if (
        previous &&
        conflictPolicy === "first-wins-cross-plugin" &&
        previous.pluginId !== opts?.pluginId
      ) {
        // A different plugin already owns this key — the incumbent wins.
        // Report and leave the store untouched; the caller gets the
        // incumbent back as the collision signal.
        onConflict?.({
          name: options?.name,
          key,
          existingPluginId: previous.pluginId,
          incomingPluginId: opts?.pluginId,
        })
        return previous
      }

      store.set(key, {
        entry,
        pluginId: opts?.pluginId,
        meta: metadata?.(entry, opts),
      })
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
        meta: value.meta,
      }))
    },

    __resetForTesting() {
      store.clear()
    },
  }
}
