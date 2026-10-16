/**
 * One `chrome.storage` area, as the agent modules use it.
 *
 * Injected rather than imported so every module here runs under Jest with a
 * Map behind it, and so which area holds what is a decision made in one place
 * (`chrome-agent-browser.ts`): agent sessions and pending site questions live
 * in `session` — memory only, gone when the browser exits — and the person's
 * standing site decisions in `local`.
 */
export interface StorageArea {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  /** Be told when `key` changes; the listener gets the new value or `null`. */
  onChange(key: string, listener: (value: unknown) => void): () => void
}

/** A Map-backed area for tests and for code that has no chrome.storage. */
export function memoryStorageArea(): StorageArea & { snapshot(): Map<string, unknown> } {
  const values = new Map<string, unknown>()
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const emit = (key: string, value: unknown) => {
    for (const listener of listeners.get(key) ?? []) listener(value)
  }
  return {
    async get<T>(key: string) {
      return (values.has(key) ? (structuredClone(values.get(key)) as T) : null) ?? null
    },
    async set(key, value) {
      values.set(key, structuredClone(value))
      emit(key, structuredClone(value))
    },
    async remove(key) {
      values.delete(key)
      emit(key, null)
    },
    onChange(key, listener) {
      const set = listeners.get(key) ?? new Set()
      set.add(listener)
      listeners.set(key, set)
      return () => set.delete(listener)
    },
    snapshot: () => values,
  }
}
