/**
 * Generic OS-keyring access for cognia-next subsystems that need to keep
 * tokens off IndexedDB. Each call is keyed by `(namespace, key)` so callers
 * can carve their own namespace without colliding with the existing
 * subscription / sidecar credentials.
 *
 * Desktop (Tauri):
 *   - Routes through the `keyring_secret_get / set / clear` IPC commands
 *     (see `src-tauri/src/keyring_secrets.rs`). The Rust side uses the
 *     `keyring` crate with service name `com.cognia.<namespace>/v1`.
 *
 * Web (browser / Capacitor):
 *   - Falls back to an AES-GCM-encrypted blob in IndexedDB. The encryption
 *     key is derived from `WebKeyringConfig.passphrase` (provided by the
 *     caller — typically the user's backup passphrase via `getDefaultBackupPassphrase`).
 *     Without a passphrase the fallback refuses writes; reads return null.
 *
 * Both paths share the same TS interface so call sites don't branch on
 * runtime — they just `await getSecret("demo-delivery", "account:primary")`.
 */

import { isTauri } from "@/lib/tauri"
import { invoke } from "@tauri-apps/api/core"

const WEB_FALLBACK_TABLE = "secretsFallback"

export interface KeyringRef {
  namespace: string
  key: string
}

interface IpcInput {
  namespace: string
  key: string
  value?: string
}

async function safeInvoke<T>(name: string, payload?: unknown): Promise<T | null> {
  if (!isTauri()) return null
  try {
    return (await invoke(name, payload as Record<string, unknown>)) as T
  } catch (err) {
    console.warn("keyring IPC failed", { name, error: err instanceof Error ? err.message : err })
    return null
  }
}

/**
 * Same as {@link safeInvoke} but propagates errors instead of swallowing them.
 * Used by `setSecret` so a failed keyring write doesn't silently return void.
 */
async function safeInvokeThrowing<T>(name: string, payload?: unknown): Promise<T> {
  if (!isTauri()) throw new Error("Keyring IPC unavailable: not in Tauri environment")
  return (await invoke(name, payload as Record<string, unknown>)) as T
}

/**
 * Read a secret. Returns `null` when the entry is missing, the Rust call
 * fails, or the web fallback has no passphrase configured.
 */
export async function getSecret(ref: KeyringRef): Promise<string | null> {
  if (isTauri()) {
    const value = await safeInvoke<string | null>("keyring_secret_get", {
      input: { namespace: ref.namespace, key: ref.key } satisfies IpcInput,
    })
    return value ?? null
  }
  return readWebFallback(ref)
}

/** Upsert a secret. `value` cannot be empty — call {@link clearSecret} instead. */
export async function setSecret(ref: KeyringRef, value: string): Promise<void> {
  if (!value) throw new Error("setSecret: value must not be empty")
  if (isTauri()) {
    await safeInvokeThrowing<void>("keyring_secret_set", {
      input: { namespace: ref.namespace, key: ref.key, value } satisfies IpcInput,
    })
    return
  }
  await writeWebFallback(ref, value)
}

/** Remove an entry. Idempotent. */
export async function clearSecret(ref: KeyringRef): Promise<void> {
  if (isTauri()) {
    await safeInvoke<null>("keyring_secret_clear", {
      input: { namespace: ref.namespace, key: ref.key } satisfies IpcInput,
    })
    return
  }
  await deleteWebFallback(ref)
}

// ── Web-mode fallback ────────────────────────────────────────────────────────

type WebRow = { id: string; ciphertext: string; iv: string; salt: string; updatedAt: number }

let webPassphrase: string | null = null

/**
 * Inject the passphrase used for the AES-GCM web fallback. Typically called
 * once on app boot with the user's backup passphrase (which is already
 * derived from a trusted source). When absent, web fallback reads return
 * `null` and writes throw.
 */
export function setWebKeyringPassphrase(passphrase: string | null): void {
  webPassphrase = passphrase
}

function fallbackRowId(ref: KeyringRef): string {
  return `${ref.namespace}::${ref.key}`
}

async function openFallbackDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null
  return await new Promise<IDBDatabase | null>((resolve) => {
    const req = indexedDB.open("cognia-keyring", 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(WEB_FALLBACK_TABLE)) {
        db.createObjectStore(WEB_FALLBACK_TABLE, { keyPath: "id" })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

async function readWebFallback(ref: KeyringRef): Promise<string | null> {
  if (!webPassphrase) return null
  const db = await openFallbackDb()
  if (!db) return null
  try {
    const row = await new Promise<WebRow | null>((resolve) => {
      const tx = db.transaction(WEB_FALLBACK_TABLE, "readonly")
      const req = tx.objectStore(WEB_FALLBACK_TABLE).get(fallbackRowId(ref))
      req.onsuccess = () => resolve((req.result as WebRow | undefined) ?? null)
      req.onerror = () => resolve(null)
    })
    if (!row) return null
    return await decryptWebFallback(row, webPassphrase)
  } finally {
    db.close()
  }
}

async function writeWebFallback(ref: KeyringRef, value: string): Promise<void> {
  if (!webPassphrase) {
    throw new Error("Keyring web fallback requires a passphrase. Call setWebKeyringPassphrase().")
  }
  const db = await openFallbackDb()
  if (!db) throw new Error("Keyring web fallback: IndexedDB is unavailable")
  try {
    const row = await encryptWebFallback(ref, value, webPassphrase)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WEB_FALLBACK_TABLE, "readwrite")
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(WEB_FALLBACK_TABLE).put(row)
    })
  } finally {
    db.close()
  }
}

async function deleteWebFallback(ref: KeyringRef): Promise<void> {
  const db = await openFallbackDb()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(WEB_FALLBACK_TABLE, "readwrite")
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.objectStore(WEB_FALLBACK_TABLE).delete(fallbackRowId(ref))
    })
  } finally {
    db.close()
  }
}

const PBKDF2_ITER = 600_000

async function deriveAesKey(passphrase: string, saltBytes: Uint8Array): Promise<CryptoKey> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("Web Crypto unavailable")
  const baseKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  )
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes as BufferSource,
      iterations: PBKDF2_ITER,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

function toBase64(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64")
}

function fromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(value)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

async function encryptWebFallback(
  ref: KeyringRef,
  value: string,
  passphrase: string
): Promise<WebRow> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("Web Crypto unavailable")
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveAesKey(passphrase, salt)
  const cipher = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(value)
  )
  return {
    id: fallbackRowId(ref),
    ciphertext: toBase64(new Uint8Array(cipher)),
    iv: toBase64(iv),
    salt: toBase64(salt),
    updatedAt: Date.now(),
  }
}

async function decryptWebFallback(row: WebRow, passphrase: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return null
    const salt = fromBase64(row.salt)
    const iv = fromBase64(row.iv)
    const cipher = fromBase64(row.ciphertext)
    const key = await deriveAesKey(passphrase, salt)
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      cipher as BufferSource
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}
