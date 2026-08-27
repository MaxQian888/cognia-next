/**
 * The device key, kept where the extension itself cannot read it back.
 *
 * `chrome.storage.local` is not a vault — anything that can read the browser
 * profile directory can read it — so the private key never goes there. The
 * sequence is:
 *
 *  1. generate an **extractable** P-256 pair, because the public half has to be
 *     exported once as SPKI for registration;
 *  2. export the public half, derive the PEM and the thumbprint the Host will
 *     store;
 *  3. re-import the private half with `extractable: false`;
 *  4. put that `CryptoKey` in IndexedDB — structured clone accepts a
 *     non-extractable key, and what comes back out can sign but cannot be read;
 *  5. drop every reference to the extractable original.
 *
 * After step 5 the secret cannot be exfiltrated by this extension, by a
 * compromised page, or by anyone reading the profile off disk. That is
 * stricter than the desktop app, which persists a JWK because it has a vault
 * to persist it into; here there is none, so the key is made unreadable
 * instead.
 *
 * The thumbprint is `hex(SHA-256(publicKeyPem))` — a hash of the PEM *text*,
 * not an RFC 7638 JWK thumbprint. That is what the Rust side computes, and the
 * two must agree or every request fails `token_key_mismatch`.
 */

const DB_NAME = "cognia-companion"
const DB_VERSION = 1
const STORE = "device-keys"
const KEY_ID = "device"

export interface DeviceKeyMaterial {
  /** Signs, and cannot be exported. */
  privateKey: CryptoKey
  publicKeyPem: string
  thumbprint: string
}

/** Generate a fresh device identity and persist the unreadable private half. */
export async function createDeviceKey(): Promise<DeviceKeyMaterial> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey)
  const publicKeyPem = spkiToPem(spki)
  const thumbprint = await sha256Hex(new TextEncoder().encode(publicKeyPem))

  // Round-trip the private half through a JWK so it can be re-imported as
  // non-extractable. The JWK is a local, short-lived value; nothing stores it.
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  )
  await putStoredKey(privateKey)
  return { privateKey, publicKeyPem, thumbprint }
}

/** The stored private key, or `null` when this browser has never paired. */
export async function loadDeviceKey(): Promise<CryptoKey | null> {
  const db = await openDb()
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY_ID)
      request.onsuccess = () => resolve((request.result as CryptoKey | undefined) ?? null)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

/** Forget the key. Used by "disconnect", and after the Host revokes us. */
export async function clearDeviceKey(): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(KEY_ID)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

async function putStoredKey(key: CryptoKey): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(key, KEY_ID)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** SPKI bytes → the PEM text the Host hashes and stores. */
export function spkiToPem(spki: ArrayBuffer): string {
  const bytes = new Uint8Array(spki)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = btoa(binary)
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
