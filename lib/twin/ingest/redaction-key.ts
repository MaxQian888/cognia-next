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
import type { AppSettings } from "@cognia/agent-config-types"

const KEYRING_REF = { namespace: "twin-redaction", key: "master" } as const

/**
 * Field key on the `AppSettings` singleton row. Treated as an
 * AppSettings extension — declared via cast since the production
 * `AppSettings` type doesn't list every minor field by name.
 */
const SETTINGS_FIELD = "twinRedactionMasterKey"

/**
 * Fingerprint of the master key, stored in the Dexie `settings` row in BOTH
 * Tauri and web modes (deliberately NOT in the keyring). It lets us tell
 * "no key yet — genuine first run" apart from "a key existed but the secret
 * store stopped returning it" (keyring locked / unavailable / the keyring-mock
 * that evaporates on restart). The latter must NOT silently re-bootstrap, or
 * every existing `redactionMapEnc` blob is orphaned.
 */
const FINGERPRINT_FIELD = "twinRedactionKeyFingerprint"

/**
 * Thrown when the master key is missing-but-previously-existed, or present but
 * does not match the recorded fingerprint, or when an AES-GCM tag check fails.
 * Callers (workbench unredact, exports) can catch this to tell the user the
 * redaction maps are unrecoverable rather than surfacing an opaque crypto error.
 */
export class RedactionKeyMismatchError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "RedactionKeyMismatchError"
    this.cause = cause
  }
}

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is required for twin redaction encryption")
  }
  return subtle
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  // Jest's jsdom realm creates its own Uint8Array / ArrayBuffer constructors,
  // while the test harness supplies Node's WebCrypto implementation. Node
  // correctly rejects those foreign-realm objects as BufferSource inputs.
  // Buffer is backed by Node's native realm, so copy through it when present;
  // browsers keep the ordinary detached ArrayBuffer copy below.
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes) as unknown as BufferSource
  }
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
    (AppSettings & { [SETTINGS_FIELD]?: string }) | undefined
  const raw = row?.[SETTINGS_FIELD]
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    return decodeBase64(raw)
  } catch {
    return null
  }
}

/** Base64 SHA-256 of the raw key bytes — the fingerprint we persist + compare. */
async function fingerprintOf(bytes: Uint8Array): Promise<string> {
  const digest = await getSubtle().digest("SHA-256", toBufferSource(bytes))
  return encodeBase64(new Uint8Array(digest))
}

async function readStoredFingerprint(): Promise<string | null> {
  const row = (await getDb().settings.get("singleton")) as
    (AppSettings & { [FINGERPRINT_FIELD]?: string }) | undefined
  const fp = row?.[FINGERPRINT_FIELD]
  return typeof fp === "string" && fp.length > 0 ? fp : null
}

async function writeStoredFingerprint(fp: string): Promise<void> {
  const db = getDb()
  const existing = ((await db.settings.get("singleton")) ?? {
    id: "singleton",
  }) as AppSettings & { [FINGERPRINT_FIELD]?: string }
  await db.settings.put({ ...existing, [FINGERPRINT_FIELD]: fp } as AppSettings)
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
 * Resolve the redaction master key.
 *
 * Bootstraps a fresh 32-byte random key ONLY on a genuine first run (no key
 * and no recorded fingerprint). The recorded fingerprint is the safety latch:
 *   • key missing + fingerprint present → the secret store lost the key
 *     (keyring locked / unavailable / evaporated). Throw `RedactionKeyMismatchError`
 *     instead of regenerating — regenerating would orphan every existing
 *     `redactionMapEnc` blob with no loud signal.
 *   • key present + fingerprint mismatch → key was rotated/replaced. Throw.
 *   • key present + no fingerprint → pre-hardening profile; adopt the current
 *     key's fingerprint so future mismatches are caught.
 *
 * If the secret-store read itself throws, that propagates (a read failure is
 * never treated as "no key yet").
 */
export async function getRedactionKey(): Promise<CryptoKey> {
  let bytes = await readMasterKeyBytes()
  const storedFingerprint = await readStoredFingerprint()

  if (!bytes) {
    if (storedFingerprint) {
      throw new RedactionKeyMismatchError(
        "Twin redaction master key is missing but a key fingerprint is recorded — " +
          "the secret store is unavailable or the key was lost. Existing redaction " +
          "maps cannot be decrypted until the key is restored."
      )
    }
    // Genuine first run — bootstrap key + fingerprint together.
    bytes = randomBytes(32)
    await writeMasterKeyBytes(bytes)
    await writeStoredFingerprint(await fingerprintOf(bytes))
  } else {
    if (bytes.length !== 32) {
      // A truncated or oversized key would be an integrity issue — refuse
      // rather than silently coerce. Caller has to clear + regenerate.
      throw new Error(
        `Twin redaction master key has unexpected length ${bytes.length} (expected 32)`
      )
    }
    const fp = await fingerprintOf(bytes)
    if (storedFingerprint && storedFingerprint !== fp) {
      throw new RedactionKeyMismatchError(
        "Twin redaction master key does not match the recorded fingerprint — the key " +
          "was rotated or replaced. Existing redaction maps were encrypted with a " +
          "different key and cannot be decrypted."
      )
    }
    if (!storedFingerprint) await writeStoredFingerprint(fp)
  }

  return getSubtle().importKey("raw", toBufferSource(bytes), { name: "AES-GCM" }, false, [
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
  if (isTauri()) await clearSecret(KEYRING_REF)
  // Always clear the Dexie-side fields (key in web mode, fingerprint in both)
  // so the next `getRedactionKey` sees a genuine first run and re-bootstraps.
  const db = getDb()
  const existing = ((await db.settings.get("singleton")) ?? {
    id: "singleton",
  }) as AppSettings & { [SETTINGS_FIELD]?: string; [FINGERPRINT_FIELD]?: string }
  if (existing[SETTINGS_FIELD] || existing[FINGERPRINT_FIELD]) {
    const next = { ...existing }
    delete next[SETTINGS_FIELD]
    delete next[FINGERPRINT_FIELD]
    await db.settings.put(next)
  }
}

// ── Encryption primitives ────────────────────────────────────────────────────

import type { RedactionRecord } from "@cognia/redact"

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
    { name: "AES-GCM", iv: toBufferSource(iv) },
    key,
    toBufferSource(plaintext)
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
  let plaintext: ArrayBuffer
  try {
    plaintext = await getSubtle().decrypt(
      { name: "AES-GCM", iv: toBufferSource(iv) },
      key,
      toBufferSource(ciphertext)
    )
  } catch (err) {
    // A GCM tag failure here means the key in hand differs from the one that
    // wrote this blob — surface it as the typed, recoverable error.
    throw new RedactionKeyMismatchError(
      "Failed to decrypt the redaction map — the encryption key changed since this " +
        "source was ingested, so the original values cannot be recovered.",
      err
    )
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, RedactionRecord>
}
