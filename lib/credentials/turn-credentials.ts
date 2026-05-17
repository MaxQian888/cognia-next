"use client"

/**
 * TURN credential storage backed by the OS keyring (desktop) or
 * Capacitor SecureStorage (mobile). Keeps `username` + `credential` out
 * of IndexedDB so a renderer-side XSS or a stolen disk image doesn't
 * leak the TURN secret.
 *
 * Dexie still stores the TURN entry's `urls` and a sentinel
 * `credential` string of the form `"kr:<keyId>"`. The keyring entry at
 * `<keyId>` is a JSON blob `{ username, credential }`. The renderer
 * resolves the sentinel on the hot path (config build, server
 * configure) — Rust never sees the sentinel.
 *
 * Backends, in order of preference:
 *   - **Tauri desktop** — `keyring_secret_*` commands in
 *     `src-tauri/src/keyring_secrets.rs` → OS keyring (Keychain /
 *     Credential Manager / Secret Service).
 *   - **Capacitor mobile** — `SecureStoragePlugin` → iOS Keychain /
 *     Android Keystore.
 *   - **Web / SSR / dev** — in-memory fallback. A warning is logged on
 *     first use; this path is for local development only.
 */

import { isCapacitor, isTauri, transport } from "@/lib/tauri"

/** Sentinel prefix used in `RTCIceServer.credential` to indicate the
 *  real credential lives in the OS keyring under a separate key id. */
export const KEYRING_CREDENTIAL_PREFIX = "kr:"

/** Namespace passed to the Rust keyring layer. Surfaces in Keychain /
 *  Credential Manager UIs as `com.cognia.webrtc-turn/v1`. */
const KEYRING_NAMESPACE = "webrtc-turn"

export interface TurnCredentialValue {
  username: string
  credential: string
}

interface TurnCredentialStore {
  save(keyId: string, value: TurnCredentialValue): Promise<void>
  load(keyId: string): Promise<TurnCredentialValue | null>
  delete(keyId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Backend: Tauri (OS keyring)
// ---------------------------------------------------------------------------

class TauriKeyringStore implements TurnCredentialStore {
  async save(keyId: string, value: TurnCredentialValue): Promise<void> {
    await transport.call<void>("keyring_secret_set", {
      input: {
        namespace: KEYRING_NAMESPACE,
        key: keyId,
        value: JSON.stringify(value),
      },
    })
  }
  async load(keyId: string): Promise<TurnCredentialValue | null> {
    const raw = await transport.call<string | null>("keyring_secret_get", {
      input: { namespace: KEYRING_NAMESPACE, key: keyId },
    })
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<TurnCredentialValue>
      if (typeof parsed?.username === "string" && typeof parsed?.credential === "string") {
        return { username: parsed.username, credential: parsed.credential }
      }
      return null
    } catch {
      return null
    }
  }
  async delete(keyId: string): Promise<void> {
    await transport.call<void>("keyring_secret_clear", {
      input: { namespace: KEYRING_NAMESPACE, key: keyId },
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

/** Lazy import so the plugin is only loaded inside Capacitor. */
async function loadSecureStorage(): Promise<SecureStoragePluginShape | null> {
  try {
    const mod = (await import(/* @vite-ignore */ "@capacitor-community/secure-storage-plugin")) as {
      SecureStoragePlugin?: SecureStoragePluginShape
    }
    return mod.SecureStoragePlugin ?? null
  } catch {
    return null
  }
}

class CapacitorSecureStore implements TurnCredentialStore {
  private cache: Promise<SecureStoragePluginShape | null> | null = null
  private get plugin(): Promise<SecureStoragePluginShape | null> {
    if (!this.cache) {
      this.cache = loadSecureStorage()
    }
    return this.cache
  }
  private prefixed(keyId: string): string {
    return `${KEYRING_NAMESPACE}.${keyId}`
  }
  async save(keyId: string, value: TurnCredentialValue): Promise<void> {
    const plugin = await this.plugin
    if (!plugin) throw new Error("SecureStoragePlugin unavailable")
    await plugin.set({ key: this.prefixed(keyId), value: JSON.stringify(value) })
  }
  async load(keyId: string): Promise<TurnCredentialValue | null> {
    const plugin = await this.plugin
    if (!plugin) return null
    try {
      const got = await plugin.get({ key: this.prefixed(keyId) })
      const parsed = JSON.parse(got.value) as Partial<TurnCredentialValue>
      if (typeof parsed?.username === "string" && typeof parsed?.credential === "string") {
        return { username: parsed.username, credential: parsed.credential }
      }
      return null
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

class InMemoryStore implements TurnCredentialStore {
  private readonly store = new Map<string, TurnCredentialValue>()
  private warned = false
  private warn(): void {
    if (this.warned) return
    this.warned = true
    console.warn(
      "[turn-credentials] No OS keyring available — TURN credentials are kept in process memory only. " +
        "This path is intended for local development; deploy to Tauri or Capacitor for real persistence."
    )
  }
  async save(keyId: string, value: TurnCredentialValue): Promise<void> {
    this.warn()
    this.store.set(keyId, { ...value })
  }
  async load(keyId: string): Promise<TurnCredentialValue | null> {
    return this.store.get(keyId) ? { ...this.store.get(keyId)! } : null
  }
  async delete(keyId: string): Promise<void> {
    this.store.delete(keyId)
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

let backend: TurnCredentialStore | null = null

function pickBackend(): TurnCredentialStore {
  if (backend) return backend
  if (isTauri()) {
    backend = new TauriKeyringStore()
  } else if (isCapacitor()) {
    backend = new CapacitorSecureStore()
  } else {
    backend = new InMemoryStore()
  }
  return backend
}

/** Test hook — overrides the runtime backend selection. Production must
 *  not call this; the renderer detects the host via `isTauri()` /
 *  `isCapacitor()`. */
export function __setTurnCredentialBackend(store: TurnCredentialStore | null): void {
  backend = store
}

/** Persist a TURN credential pair under a stable opaque keyId. The
 *  caller embeds the keyId into `RTCIceServer.credential` as
 *  `"kr:<keyId>"` so the rest of the codebase still operates on a flat
 *  `RTCIceServer[]` shape. */
export function saveTurnCredential(keyId: string, value: TurnCredentialValue): Promise<void> {
  return pickBackend().save(keyId, value)
}

/** Look up a TURN credential pair. Returns `null` when the keyring is
 *  empty or returns malformed JSON. */
export function loadTurnCredential(keyId: string): Promise<TurnCredentialValue | null> {
  return pickBackend().load(keyId)
}

/** Remove a credential entry. Idempotent. */
export function deleteTurnCredential(keyId: string): Promise<void> {
  return pickBackend().delete(keyId)
}

/** Generate a fresh credential keyId. Used by the migration path and
 *  by the "save new TURN entry" path in `WebRtcCard`. Cryptographically
 *  random to avoid collision with existing keyring entries. */
export function freshCredentialKeyId(): string {
  // crypto.randomUUID is available in every supported runtime (Tauri
  // webview, Capacitor, modern browsers). Fallback to Math.random
  // string only if the API is missing — which won't happen in production
  // but keeps tests from crashing on an exotic SSR host.
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof c?.randomUUID === "function") return c.randomUUID()
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Return `true` if `credential` is a keyring sentinel (i.e. the actual
 *  credential lives in the OS keyring, not Dexie). */
export function isKeyringSentinel(credential: string | undefined | null): boolean {
  return typeof credential === "string" && credential.startsWith(KEYRING_CREDENTIAL_PREFIX)
}

/** Extract the keyId from a `"kr:<keyId>"` sentinel. Returns `null` if
 *  the input isn't a sentinel. */
export function keyIdOfSentinel(credential: string | undefined | null): string | null {
  if (!isKeyringSentinel(credential)) return null
  return credential!.slice(KEYRING_CREDENTIAL_PREFIX.length)
}

/** Migrate any legacy plaintext TURN entries to the keyring.
 *
 * - Entries with an empty / missing credential pass through unchanged.
 * - Entries whose credential is already a `"kr:<keyId>"` sentinel pass
 *   through unchanged (already migrated).
 * - Entries with plaintext `username` + `credential` get a fresh
 *   keyId, the pair is written to the keyring, and the returned entry
 *   carries the sentinel in `credential` (and clears `username`).
 *
 * `didMigrate` is `true` when at least one entry was rewritten — the
 * caller can use this to decide whether to persist the result back to
 * Dexie. Idempotent on repeat invocations.
 */
export async function migrateTurnServersToKeyring(
  servers: RTCIceServer[] | undefined
): Promise<{ migrated: RTCIceServer[]; didMigrate: boolean }> {
  if (!servers || servers.length === 0) {
    return { migrated: [], didMigrate: false }
  }
  let didMigrate = false
  const migrated: RTCIceServer[] = []
  for (const server of servers) {
    const credentialRaw = typeof server.credential === "string" ? server.credential : undefined
    const username = typeof server.username === "string" ? server.username : ""
    if (!credentialRaw || isKeyringSentinel(credentialRaw)) {
      migrated.push(server)
      continue
    }
    // Plaintext credential present — promote to keyring.
    const keyId = freshCredentialKeyId()
    try {
      await saveTurnCredential(keyId, {
        username,
        credential: credentialRaw,
      })
    } catch (err) {
      console.warn(
        "[turn-credentials] keyring write failed during migration; leaving plaintext entry as-is",
        err
      )
      migrated.push(server)
      continue
    }
    didMigrate = true
    migrated.push({
      urls: server.urls,
      // Username is stored alongside the credential in the keyring blob,
      // so we clear it from the Dexie copy too. Resolution time pulls
      // both fields back together.
      credential: `${KEYRING_CREDENTIAL_PREFIX}${keyId}`,
    })
  }
  return { migrated, didMigrate }
}

/** Take an array of `RTCIceServer` entries (possibly with keyring
 *  sentinels in `credential`) and return a fresh array where every
 *  entry has its credential resolved to the real value. Used by the
 *  desktop / mobile controllers right before they hand the patch to
 *  the Rust side or assign to `RTCConfiguration`. */
export async function resolveTurnServerCredentials(
  servers: RTCIceServer[]
): Promise<RTCIceServer[]> {
  const out: RTCIceServer[] = []
  for (const server of servers) {
    const credentialRaw = typeof server.credential === "string" ? server.credential : undefined
    if (!isKeyringSentinel(credentialRaw)) {
      out.push(server)
      continue
    }
    const keyId = keyIdOfSentinel(credentialRaw)!
    const resolved = await loadTurnCredential(keyId)
    if (!resolved) {
      // The keyring entry was deleted out-of-band (the user wiped their
      // keychain, or the OS migrated profiles). Surface the URL without
      // credentials so STUN-only fallbacks still work, but emit a
      // warning so the dev tools breadcrumb is visible.
      console.warn(`[turn-credentials] missing keyring entry for keyId=${keyId}`)
      out.push({ urls: server.urls })
      continue
    }
    out.push({
      urls: server.urls,
      username: resolved.username,
      credential: resolved.credential,
    })
  }
  return out
}
