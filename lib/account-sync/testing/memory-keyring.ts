/** A `KeyringStore` in a Map, for tests; `persistent` toggles like a Browser Vault locking. */

import type { KeyringStore } from "@/lib/credentials/keyring-store"

export interface MemoryKeyring extends KeyringStore {
  readonly values: Map<string, string>
  persistent: boolean
}

export function createMemoryKeyring(): MemoryKeyring {
  const values = new Map<string, string>()
  return {
    values,
    persistent: true,
    async save(key, value) {
      values.set(key, value)
    },
    async load(key) {
      return values.get(key) ?? null
    },
    async delete(key) {
      values.delete(key)
    },
    isPersistent() {
      return this.persistent
    },
  }
}
