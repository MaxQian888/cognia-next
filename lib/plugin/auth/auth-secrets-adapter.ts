/**
 * Adapts the plugin `ctx.secrets` API to the auth-provider registry's
 * `SecretsAdapter` (C1). The registry needs `list(prefix)` to rehydrate
 * sessions on boot, but `PluginSecretsAPI` has no list operation (OS keyrings
 * don't enumerate). We back `list` with a single JSON index key
 * (`auth:__index__`) that tracks every auth key written — avoiding a new Rust
 * gateway op. The index is best-effort: a corrupt index degrades to "no
 * sessions", never throws.
 */

import type { SecretsAdapter } from "./auth-provider-registry"

/** The subset of `ctx.secrets` this adapter needs. */
export interface SecretsBackend {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

const INDEX_KEY = "auth:__index__"

async function readIndex(backend: SecretsBackend): Promise<string[]> {
  try {
    const raw = await backend.get(INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []
  } catch {
    return []
  }
}

async function writeIndex(backend: SecretsBackend, keys: string[]): Promise<void> {
  try {
    await backend.set(INDEX_KEY, JSON.stringify([...new Set(keys)]))
  } catch {
    // Index write failures are non-fatal — the session value is still stored;
    // only boot-time rehydration of that key is affected.
  }
}

export function createAuthSecretsAdapter(backend: SecretsBackend): SecretsAdapter {
  return {
    async get(key) {
      const v = await backend.get(key)
      return v ?? undefined
    },
    async set(key, value) {
      await backend.set(key, value)
      const index = await readIndex(backend)
      if (!index.includes(key)) await writeIndex(backend, [...index, key])
    },
    async delete(key) {
      await backend.delete(key)
      const index = await readIndex(backend)
      if (index.includes(key))
        await writeIndex(
          backend,
          index.filter((k) => k !== key)
        )
    },
    async list(prefix) {
      const index = await readIndex(backend)
      return index.filter((k) => k.startsWith(prefix))
    },
  }
}
