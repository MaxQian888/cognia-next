export interface OverlayRegistry<T> {
  register(
    id: string,
    entry: T,
    opts?: { pluginId?: string }
  ): { entry: T; pluginId?: string; meta?: Record<string, unknown> } | undefined
  unregisterById(id: string): boolean
  unregisterByPlugin(pluginId: string): number
  get(id: string): T | undefined
  getEntry(id: string): { entry: T; pluginId?: string; meta?: Record<string, unknown> } | undefined
  list(): string[]
  entries(): Array<{ id: string; entry: T; pluginId?: string; meta?: Record<string, unknown> }>
  __resetForTesting(): void
}

export interface OverlayConflictInfo {
  name?: string
  key: string
  existingPluginId?: string
  incomingPluginId?: string
}

export interface CreateOverlayRegistryOptions<T> {
  name?: string
  keyFn?: (id: string, entry: T, opts?: { pluginId?: string }) => string
  conflictPolicy?: "last-wins" | "first-wins-cross-plugin"
  onConflict?: (info: OverlayConflictInfo) => void
  metadata?: (entry: T, opts?: { pluginId?: string }) => Record<string, unknown>
}

interface InternalEntry<T> {
  entry: T
  pluginId?: string
  meta?: Record<string, unknown>
}

export function createOverlayRegistry<T>(
  options?: CreateOverlayRegistryOptions<T>
): OverlayRegistry<T> {
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
