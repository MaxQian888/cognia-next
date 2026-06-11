"use client"

/**
 * Generic, namespace-parameterized secret store backed by the OS keyring
 * (Tauri) or Capacitor SecureStorage (mobile), with an in-memory fallback
 * for web/dev. Stores opaque strings — callers serialize their own shape.
 *
 * This is the generalized form of the credential store in
 * `turn-credentials.ts` (which predates it and keeps its own, well-tested
 * copy for the static-TURN path). New secret kinds — e.g. the ephemeral
 * TURN provider API token (ADR-0021) — use this under their own namespace
 * so secrets never land in Dexie.
 *
 * Backends, in order of preference:
 *   - **Tauri desktop** — `keyring_secret_*` commands → OS keyring.
 *   - **Capacitor mobile** — `SecureStoragePlugin` → iOS Keychain /
 *     Android Keystore.
 *   - **Web / SSR / dev** — in-memory fallback (per-instance).
 */

import { isCapacitor, isTauri, transport } from "@/lib/tauri"
import { makeDefaultLoader } from "@/lib/capacitor/_shared"

export interface KeyringStore {
  save(keyId: string, value: string): Promise<void>
  load(keyId: string): Promise<string | null>
  delete(keyId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Backend: Tauri (OS keyring)
// ---------------------------------------------------------------------------

class TauriKeyringStore implements KeyringStore {
  constructor(private readonly namespace: string) {}
  async save(keyId: string, value: string): Promise<void> {
    await transport.call<void>("keyring_secret_set", {
      input: { namespace: this.namespace, key: keyId, value },
    })
  }
  async load(keyId: string): Promise<string | null> {
    const raw = await transport.call<string | null>("keyring_secret_get", {
      input: { namespace: this.namespace, key: keyId },
    })
    return raw ?? null
  }
  async delete(keyId: string): Promise<void> {
    await transport.call<void>("keyring_secret_clear", {
      input: { namespace: this.namespace, key: keyId },
    })
  }
}

// ---------------------------------------------------------------------------
// Backend: Capacitor (SecureStoragePlugin)
// ---------------------------------------------------------------------------

interface SecureStoragePluginShape {
  set(opts: { key: string; value: string }): Promise<unknown>
  get(opts: { key: string }): Promise<{ value: string }>
  remove(opts: { key: string }): Promise<unknown>
}

/** Resolve the SecureStorage plugin via the canonical loader. The
 *  package-name literal MUST stay in lockstep with `mobile/package.json`
 *  (see the `turn-credentials.ts` regression test). Errors collapse to
 *  `null` so the caller can fall back to the in-memory store. */
async function loadSecureStorage(): Promise<SecureStoragePluginShape | null> {
  try {
    return await makeDefaultLoader<SecureStoragePluginShape>(
      "capacitor-secure-storage-plugin",
      "SecureStoragePlugin"
    )()
  } catch {
    return null
  }
}

class CapacitorSecureStore implements KeyringStore {
  constructor(private readonly namespace: string) {}
  private cache: Promise<SecureStoragePluginShape | null> | null = null
  private get plugin(): Promise<SecureStoragePluginShape | null> {
    if (!this.cache) this.cache = loadSecureStorage()
    return this.cache
  }
  private prefixed(keyId: string): string {
    return `${this.namespace}.${keyId}`
  }
  async save(keyId: string, value: string): Promise<void> {
    const plugin = await this.plugin
    if (!plugin) throw new Error("SecureStoragePlugin unavailable")
    await plugin.set({ key: this.prefixed(keyId), value })
  }
  async load(keyId: string): Promise<string | null> {
    const plugin = await this.plugin
    if (!plugin) return null
    try {
      const got = await plugin.get({ key: this.prefixed(keyId) })
      return typeof got.value === "string" ? got.value : null
    } catch {
      return null
    }
  }
  async delete(keyId: string): Promise<void> {
    const plugin = await this.plugin
    if (!plugin) return
    try {
      await plugin.remove({ key: this.prefixed(keyId) })
    } catch {
      // Missing keys are fine; the plugin throws on absence.
    }
  }
}

// ---------------------------------------------------------------------------
// Backend: web / dev fallback (in-memory)
// ---------------------------------------------------------------------------

class InMemoryStore implements KeyringStore {
  private readonly store = new Map<string, string>()
  private warned = false
  private warn(): void {
    if (this.warned) return
    this.warned = true
    console.warn(
      "[keyring-store] No OS keyring available — secrets are kept in process memory only. " +
        "This path is intended for local development; deploy to Tauri or Capacitor for real persistence."
    )
  }
  async save(keyId: string, value: string): Promise<void> {
    this.warn()
    this.store.set(keyId, value)
  }
  async load(keyId: string): Promise<string | null> {
    return this.store.has(keyId) ? this.store.get(keyId)! : null
  }
  async delete(keyId: string): Promise<void> {
    this.store.delete(keyId)
  }
}

/**
 * Build a keyring store for the given namespace. The namespace surfaces in
 * OS keyring UIs (e.g. `com.cognia.<namespace>/v1`) and prefixes the
 * Capacitor SecureStorage key, so distinct callers never collide.
 */
export function createKeyringStore(namespace: string): KeyringStore {
  if (isTauri()) return new TauriKeyringStore(namespace)
  if (isCapacitor()) return new CapacitorSecureStore(namespace)
  return new InMemoryStore()
}
