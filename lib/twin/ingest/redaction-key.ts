/**
 * PII redaction-map encryption key — dual storage strategy.
 *
 *   • Tauri: OS keyring via `lib/keyring` (service `com.cognia.twin-redaction`,
 *     account `master`). The 32-byte random key never touches IndexedDB.
 *   • Web: a base64-encoded random key stored alongside other twin metadata
 *     in the `settings` singleton row (`AppSettings.twinRedactionMasterKey`).
 *     Web mode can't get a hardware-backed key without forcing the user to
 *     type a passphrase, so we trade strong-at-rest for zero-friction; the
 *     map itself is still encrypted with AES-GCM, just the key is colocated
 *     with the data.
 *
 * Both paths converge on a `CryptoKey` (AES-GCM, 256-bit) so downstream
 * `encryptRedactionMap` / `decryptRedactionMap` callers don't branch.
 *
 * One-time bootstrap: if no key is present, generate a fresh 32-byte
 * random value and persist before returning it. The bootstrap is
 * idempotent across concurrent callers — the second one finds the row
 * the first wrote.
 */

import { isTauri } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"
import { getSecret, setSecret, clearSecret } from "@/lib/keyring"
import type { AppSettings } from "@/lib/claude/types"

const KEYRING_REF = { namespace: "twin-redaction", key: "master" } as const

/**
 * Field key on the `AppSettings` singleton row. Treated as an
 * AppSettings extension — declared via cast since the production
 * `AppSettings` type doesn't list every minor field by name.
 */
const SETTINGS_FIELD = "twinRedactionMasterKey"

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is required for twin redaction encryption")
  }
  return subtle
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  return Buffer.from(bytes).toString("base64")
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

function randomBytes(n: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random source is not available in this runtime")
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(n))
}

/**
 * Read the master key bytes. Returns null when no key exists yet. Web mode
 * reads the field straight off the `settings` singleton (no passphrase
 * required — see module docstring for the tradeoff).
 */
async function readMasterKeyBytes(): Promise<Uint8Array | null> {
  if (isTauri()) {
    const value = await getSecret(KEYRING_REF)
    if (!value) return null
    try {
      return decodeBase64(value)
    } catch {
      return null
    }
  }
  const row = (await getDb().settings.get("singleton")) as
    | (AppSettings & { [SETTINGS_FIELD]?: string })
    | undefined
  const raw = row?.[SETTINGS_FIELD]
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    return decodeBase64(raw)
  } catch {
    return null
  }
}

async function writeMasterKeyBytes(bytes: Uint8Array): Promise<void> {
  const b64 = encodeBase64(bytes)
  if (isTauri()) {
    await setSecret(KEYRING_REF, b64)
    return
  }
  const db = getDb()
  const existing = ((await db.settings.get("singleton")) ?? {
    id: "singleton",
  }) as AppSettings & { [SETTINGS_FIELD]?: string }
  await db.settings.put({ ...existing, [SETTINGS_FIELD]: b64 } as AppSettings)
}

/**
 * Resolve the redaction master key. Bootstraps a fresh 32-byte random
 * key on first call. Idempotent — concurrent callers will agree on the
 * same key (the writer/reader race window is small enough that a second
 * generation only happens under extreme contention, and the loser's key
 * is overwritten before anyone uses it).
 */
export async function getRedactionKey(): Promise<CryptoKey> {
  let bytes = await readMasterKeyBytes()
  if (!bytes) {
    bytes = randomBytes(32)
    await writeMasterKeyBytes(bytes)
  }
  if (bytes.length !== 32) {
    // A truncated or oversized key would be an integrity issue — refuse
    // rather than silently coerce. Caller has to clear + regenerate.
    throw new Error(`Twin redaction master key has unexpected length ${bytes.length} (expected 32)`)
  }
  return getSubtle().importKey("raw", toArrayBuffer(bytes), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ])
}

/**
 * Test / recovery helper: clear the master key so the next call to
 * `getRedactionKey` bootstraps a new one. **All existing
 * `twinSources.redactionMapEnc` blobs become unreadable** — only call
 * after wiping the affected source rows or accepting the data loss.
 */
export async function __resetRedactionKey(): Promise<void> {
  if (isTauri()) {
    await clearSecret(KEYRING_REF)
    return
  }
  const db = getDb()
  const existing = ((await db.settings.get("singleton")) ?? {
    id: "singleton",
  }) as AppSettings & { [SETTINGS_FIELD]?: string }
  if (existing[SETTINGS_FIELD]) {
    const next = { ...existing }
    delete next[SETTINGS_FIELD]
    await db.settings.put(next)
  }
}

// ── Encryption primitives ────────────────────────────────────────────────────

import type { RedactionRecord } from "./redact"

/** Encrypted blob shape stored as `twinSources.redactionMapEnc`. */
export interface EncryptedRedactionMap {
  /** Format version — bump when the wire shape changes. */
  v: 1
  /** Base64 IV (12 bytes). */
  iv: string
  /** Base64 ciphertext (includes the GCM tag suffix). */
  ct: string
}

/** Encrypt the in-memory redaction map. Empty map → empty string short-circuit. */
export async function encryptRedactionMap(map: Record<string, RedactionRecord>): Promise<string> {
  const entries = Object.values(map)
  if (entries.length === 0) return ""
  const key = await getRedactionKey()
  const iv = randomBytes(12)
  const plaintext = new TextEncoder().encode(JSON.stringify(map))
  const ciphertext = await getSubtle().encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext)
  )
  const blob: EncryptedRedactionMap = {
    v: 1,
    iv: encodeBase64(iv),
    ct: encodeBase64(new Uint8Array(ciphertext)),
  }
  return JSON.stringify(blob)
}

/**
 * Decrypt + parse a `twinSources.redactionMapEnc` blob. Returns an empty
 * map on falsy input so callers can blindly merge results across many
 * sources. Throws when the blob is malformed or the AES-GCM tag is wrong
 * (which would mean the key changed since this row was written).
 */
export async function decryptRedactionMap(
  serialized: string | undefined
): Promise<Record<string, RedactionRecord>> {
  if (!serialized) return {}
  const blob = JSON.parse(serialized) as EncryptedRedactionMap
  if (blob.v !== 1 || typeof blob.iv !== "string" || typeof blob.ct !== "string") {
    throw new Error("decryptRedactionMap: malformed envelope")
  }
  const key = await getRedactionKey()
  const iv = decodeBase64(blob.iv)
  const ciphertext = decodeBase64(blob.ct)
  const plaintext = await getSubtle().decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext)
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, RedactionRecord>
}
