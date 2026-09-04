/**
 * The device pepper: high-entropy material that never leaves this machine and
 * is mixed into every PIN and pattern before it touches a key.
 *
 * WHY THIS EXISTS
 *
 * A six-digit PIN is about 20 bits and a 3x3 pattern is less. Argon2id at the
 * parameters this app uses costs roughly 50ms per guess, so a million
 * candidates is a long evening, not a wall. Any design where the stored
 * material alone is enough to start guessing is therefore already lost: an
 * attacker who copies the profile directory owns the PIN.
 *
 * The pepper removes that attack entirely. The KEK is derived from the secret
 * AND from 32 random bytes that live somewhere a file copy does not reach:
 *
 *   - On the desktop host, the OS keyring. Rust owns it, the renderer never
 *     sees it, and it is bound to the OS user account.
 *   - In a browser, a NON-EXTRACTABLE `CryptoKey` kept in IndexedDB. The key
 *     object can be stored and used, but its raw bytes cannot be read back by
 *     script, so an XSS payload or an exfiltrated database dump gets a handle
 *     it cannot take with it.
 *
 * WHAT IT IS NOT
 *
 * The browser pepper is weaker than the keyring, and the difference is worth
 * being precise about rather than glossing. An attacker with code execution AS
 * THE USER on the machine can still use the key in place, because that is what
 * non-extractable means: unreadable, not unusable. What it defeats is the far
 * more common case of stolen data at rest. That is why the password remains
 * the only factor that stands alone, and why the attempt cap is a hard cap.
 */

const PEPPER_DB_NAME = "cognia-quick-unlock"
const PEPPER_STORE = "pepper"
const PEPPER_DB_VERSION = 1

/** One pepper per account, so removing an account removes its pepper. */
function pepperKey(localAccountId: string): string {
  return `pepper:${localAccountId}`
}

/**
 * Fixed message signed with the device key to produce the pepper bytes.
 *
 * A constant is fine and is the point: the secrecy is in the key, not the
 * message, and a stable message means the same device always derives the same
 * pepper.
 */
const PEPPER_MESSAGE = new TextEncoder().encode("cognia.quick-unlock.device-pepper.v1")

function subtle(): SubtleCrypto {
  const crypto = globalThis.crypto
  if (!crypto?.subtle) {
    throw new Error("WebCrypto is unavailable, so quick unlock cannot be enrolled here.")
  }
  return crypto.subtle
}

/**
 * Fetch, or mint, this device's non-extractable HMAC key for an account.
 *
 * Generated with `extractable = false`, which is the entire security property.
 * IndexedDB stores the key object by structured clone and preserves that flag,
 * so a later read gets a usable handle and never the bytes.
 */
export async function getOrCreateDeviceKey(localAccountId: string): Promise<CryptoKey> {
  const existing = await pepperStore.get(pepperKey(localAccountId))
  if (existing) return existing

  const key = await subtle().generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  await pepperStore.put(pepperKey(localAccountId), key)
  return key
}

/**
 * Derive this device's pepper bytes for an account.
 *
 * Returns 32 bytes. The caller mixes them with the user's secret. They are
 * never persisted anywhere: the KEY is persisted, and the bytes are recomputed
 * from it on demand.
 */
export async function deriveDevicePepper(localAccountId: string): Promise<Uint8Array> {
  const key = await getOrCreateDeviceKey(localAccountId)
  const signature = await subtle().sign("HMAC", key, PEPPER_MESSAGE)
  return new Uint8Array(signature)
}

/**
 * Drop an account's device key.
 *
 * Called when the account is deleted, and when the user removes every quick
 * method. Dropping it makes every existing wrap permanently unopenable, which
 * is the desired outcome in both cases.
 */
export async function clearDeviceKey(localAccountId: string): Promise<void> {
  await pepperStore.delete(pepperKey(localAccountId))
}

/**
 * Where device keys are kept.
 *
 * A seam rather than a direct call, for one specific reason: `CryptoKey` is a
 * serializable object that real browsers happily structured-clone into
 * IndexedDB, but `fake-indexeddb` under Node does not model that, so a test
 * that round-trips a key through it gets back something that is no longer a
 * key. The production default below IS the IndexedDB implementation, and
 * `defaultPepperStore` is asserted to be installed so this seam cannot quietly
 * become a path only tests take.
 */
export interface PepperStore {
  get: (key: string) => Promise<CryptoKey | null>
  put: (key: string, value: CryptoKey) => Promise<void>
  delete: (key: string) => Promise<void>
}

const defaultPepperStore: PepperStore = { get: idbGet, put: idbPut, delete: idbDelete }

let pepperStore: PepperStore = defaultPepperStore

/** Swap the persistence layer. Tests only. */
export function __setPepperStoreForTests(store: PepperStore | null): void {
  pepperStore = store ?? defaultPepperStore
}

/** Whether the production IndexedDB store is the one currently installed. */
export function isDefaultPepperStoreInstalled(): boolean {
  return pepperStore === defaultPepperStore
}

/** Whether this runtime can hold a device pepper at all. */
export function supportsDevicePepper(): boolean {
  return (
    typeof indexedDB !== "undefined" &&
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.subtle !== "undefined"
  )
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing.
//
// Raw IDB rather than Dexie, matching `wallpaper-storage.ts`: this is one
// key/value store holding CryptoKey objects, and it must not participate in
// the app database's schema versioning or its account-scoped encryption. The
// pepper has to be readable BEFORE the vault is open, which is precisely when
// the encrypted store is not.
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PEPPER_DB_NAME, PEPPER_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PEPPER_STORE)) db.createObjectStore(PEPPER_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function idbGet(key: string): Promise<CryptoKey | null> {
  const db = await openDb()
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const tx = db.transaction(PEPPER_STORE, "readonly")
      const request = tx.objectStore(PEPPER_STORE).get(key)
      request.onsuccess = () => resolve((request.result as CryptoKey | undefined) ?? null)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

async function idbPut(key: string, value: CryptoKey): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PEPPER_STORE, "readwrite")
      tx.objectStore(PEPPER_STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PEPPER_STORE, "readwrite")
      tx.objectStore(PEPPER_STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
