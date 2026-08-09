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
 *   - **Tauri desktop** — `secret_store_*` commands → encrypted store whose master key uses the OS keyring.
 *   - **Capacitor mobile** — `SecureStoragePlugin` → iOS Keychain /
 *     Android Keystore.
 *   - **Headless brain** — service-scoped companion RPC → encrypted server store.
 *   - **Web / SSR / dev** — in-memory fallback (per-instance).
 */

import { isCapacitor, isTauri, transport } from "@/lib/tauri"
import { isHeadlessHost } from "@/lib/platform/detect"
import { makeDefaultLoader } from "@/lib/capacitor/_shared"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"

export interface KeyringStore {
  save(keyId: string, value: string): Promise<void>
  load(keyId: string): Promise<string | null>
  delete(keyId: string): Promise<void>
  /** Whether values currently survive a process/browser restart. */
  isPersistent?(): boolean
}

// ---------------------------------------------------------------------------
// Backend: Tauri (OS keyring)
// ---------------------------------------------------------------------------

type KeyringCall = (name: string, params: Record<string, unknown>) => Promise<unknown>

class TauriSecretStore implements KeyringStore {
  constructor(
    private readonly namespace: string,
    private readonly call: KeyringCall
  ) {}
  async save(keyId: string, value: string): Promise<void> {
    await this.call("secret_store_set", {
      input: { namespace: this.namespace, key: keyId, value },
    })
  }
  async load(keyId: string): Promise<string | null> {
    const raw = await this.call("secret_store_get", {
      input: { namespace: this.namespace, key: keyId },
    })
    return typeof raw === "string" ? raw : null
  }
  async delete(keyId: string): Promise<void> {
    await this.call("secret_store_delete", {
      input: { namespace: this.namespace, key: keyId },
    })
  }
  isPersistent(): boolean {
    return true
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
  isPersistent(): boolean {
    return true
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
  isPersistent(): boolean {
    return false
  }
}

/**
 * Web adapter that upgrades transparently from session memory to the encrypted
 * account Browser Vault as soon as it is unlocked. The namespace remains part
 * of the stored name so independent domain modules cannot collide.
 */
class BrowserVaultStore implements KeyringStore {
  private readonly fallback = new InMemoryStore()

  constructor(private readonly namespace: string) {}

  private name(keyId: string): string {
    return `keyring:${this.namespace}:${keyId}`
  }

  async save(keyId: string, value: string): Promise<void> {
    const vault = getActiveBrowserVault()
    if (vault) {
      await vault.storeSecret(this.name(keyId), value)
      await this.fallback.delete(keyId)
      return
    }
    await this.fallback.save(keyId, value)
  }

  async load(keyId: string): Promise<string | null> {
    const vault = getActiveBrowserVault()
    if (vault) {
      const persisted = await vault.loadSecret(this.name(keyId))
      if (persisted !== null) return persisted
      const sessionValue = await this.fallback.load(keyId)
      if (sessionValue !== null) {
        // A value may have been entered while the account vault was locked.
        // Promote it before returning so the next browser session can recover
        // it; deleting the fallback happens only after the durable write.
        await vault.storeSecret(this.name(keyId), sessionValue)
        await this.fallback.delete(keyId)
        return sessionValue
      }
    }
    return this.fallback.load(keyId)
  }

  async delete(keyId: string): Promise<void> {
    const vault = getActiveBrowserVault()
    if (vault) await vault.deleteSecret(this.name(keyId))
    await this.fallback.delete(keyId)
  }

  isPersistent(): boolean {
    return getActiveBrowserVault() !== null
  }
}

/**
 * Build a keyring store for the given namespace. The namespace surfaces in
 * OS keyring UIs (e.g. `com.cognia.<namespace>/v1`) and prefixes the
 * Capacitor SecureStorage key, so distinct callers never collide.
 */
export function createKeyringStore(namespace: string): KeyringStore {
  if (isTauri() || isHeadlessHost()) {
    return new TauriSecretStore(namespace, (name, params) => transport.call(name, params))
  }
  // A number of domain tests intentionally provide a minimal `@/lib/tauri`
  // mock with only `isTauri`. Keep the Web path resilient to that supported
  // test/runtime seam instead of requiring every consumer to mock Capacitor.
  if (typeof isCapacitor === "function" && isCapacitor()) {
    return new CapacitorSecureStore(namespace)
  }
  return new BrowserVaultStore(namespace)
}

/**
 * Build a keyring store that is pinned to the current desktop process.
 *
 * Unlike {@link createKeyringStore}, this bypasses Cognia's process-wide
 * local/remote routing transport. Use it when a credential must stay on the
 * explicitly selected local execution host (for example a Sites provider
 * token). It deliberately fails outside Tauri instead of falling back to an
 * ambiguous remote or in-memory location.
 */
export function createLocalKeyringStore(namespace: string): KeyringStore {
  if (!isTauri()) throw new Error("local Tauri keyring is unavailable")
  return new TauriSecretStore(namespace, async (name, params) => {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke(name, params)
  })
}
