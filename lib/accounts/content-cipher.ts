import { decodeBase64Url, encodeBase64Url } from "@/lib/share/encoding"
import { assertAccountId } from "./account-types"

export interface EncryptedContentEnvelope {
  version: 1
  algorithm: "AES-256-GCM"
  /**
   * The LocalProfile this row belongs to.
   *
   * Deliberately still `accountId` while everything around it says
   * `localAccountId` (ADR-0149): this key is written into every encrypted row
   * on disk and re-read by `lib/db/encrypted-content-middleware.ts`, so
   * renaming it is a data migration rather than a vocabulary fix. Rename it
   * only alongside one.
   */
  accountId: string
  iv: string
  ciphertext: string
}

export interface AccountContentCipherContract {
  readonly localAccountId: string
  readonly databaseName: string
  encrypt<T>(
    table: string,
    primaryKey: unknown,
    field: string,
    schemaVersion: number,
    value: T
  ): Promise<EncryptedContentEnvelope>
  decrypt<T>(
    table: string,
    primaryKey: unknown,
    field: string,
    schemaVersion: number,
    envelope: EncryptedContentEnvelope
  ): Promise<T>
  lock(): void
}

interface CachedSessionListPayload {
  envelope: EncryptedContentEnvelope
  json: string
  bytes: number
  needsBinaryReviver: boolean
}

const SESSION_LIST_CACHE_MAX_ENTRIES = 2048
const SESSION_LIST_CACHE_MAX_BYTES = 8 * 1024 * 1024

export class AccountContentCipher implements AccountContentCipherContract {
  private key: CryptoKey | null
  private readonly sessionListCache = new Map<string, CachedSessionListPayload>()
  private sessionListCacheBytes = 0

  constructor(
    readonly localAccountId: string,
    readonly databaseName: string,
    key: CryptoKey
  ) {
    assertAccountId(localAccountId)
    if (!databaseName.startsWith(`cognia-account-${localAccountId}`)) {
      throw new Error("Content cipher database does not belong to the account.")
    }
    this.key = key
  }

  static async fromRawKey(
    localAccountId: string,
    databaseName: string,
    rawKey: Uint8Array
  ): Promise<AccountContentCipher> {
    if (rawKey.length !== 32) throw new Error("Account content DEK must be 256 bits.")
    const key = await subtle().importKey(
      "raw",
      toBufferSource(rawKey),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    )
    return new AccountContentCipher(localAccountId, databaseName, key)
  }

  static createForTesting(
    localAccountId: string,
    databaseName: string
  ): Promise<AccountContentCipher> {
    if (process.env.NODE_ENV !== "test") throw new Error("Test cipher factory is test-only.")
    return AccountContentCipher.fromRawKey(localAccountId, databaseName, randomBytes(32))
  }

  async encrypt<T>(
    table: string,
    primaryKey: unknown,
    field: string,
    schemaVersion: number,
    value: T
  ): Promise<EncryptedContentEnvelope> {
    const key = this.requireKey()
    const iv = randomBytes(12)
    const plaintext = new TextEncoder().encode(JSON.stringify(value, encodeBinary))
    try {
      const ciphertext = await subtle().encrypt(
        {
          name: "AES-GCM",
          iv: toBufferSource(iv),
          additionalData: toBufferSource(
            contentAad(this.databaseName, table, primaryKey, field, schemaVersion)
          ),
        },
        key,
        toBufferSource(plaintext)
      )
      return {
        version: 1,
        algorithm: "AES-256-GCM",
        accountId: this.localAccountId,
        iv: encodeBase64Url(iv),
        ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      }
    } finally {
      plaintext.fill(0)
      iv.fill(0)
    }
  }

  async decrypt<T>(
    table: string,
    primaryKey: unknown,
    field: string,
    schemaVersion: number,
    envelope: EncryptedContentEnvelope
  ): Promise<T> {
    const { key, aad, captured } = this.prepareDecryption(
      table,
      primaryKey,
      field,
      schemaVersion,
      envelope
    )
    const cached = this.cachedDecryption<T>(table, field, aad, captured)
    if (cached) return cached.value
    const plaintext = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: toBufferSource(decodeBase64Url(captured.iv)),
        additionalData: toBufferSource(new TextEncoder().encode(aad)),
      },
      key,
      toBufferSource(decodeBase64Url(captured.ciphertext))
    )
    const json = new TextDecoder().decode(plaintext)
    const value = JSON.parse(json, reviveBinary) as T
    // A lock during WebCrypto must not repopulate the cleared plaintext cache.
    if (table === "sessionList" && field === "payload" && this.key === key) {
      this.cacheSessionListPayload(aad, captured, json)
    }
    return value
  }

  /** An authenticated cache hit needs neither WebCrypto nor a transaction hold. */
  getCachedDecrypted<T>(
    table: string,
    primaryKey: unknown,
    field: string,
    schemaVersion: number,
    envelope: EncryptedContentEnvelope
  ): { value: T } | undefined {
    const { aad, captured } = this.prepareDecryption(
      table,
      primaryKey,
      field,
      schemaVersion,
      envelope
    )
    return this.cachedDecryption<T>(table, field, aad, captured)
  }

  private prepareDecryption(
    table: string,
    primaryKey: unknown,
    field: string,
    schemaVersion: number,
    envelope: EncryptedContentEnvelope
  ) {
    // Capture the authenticated envelope before awaiting crypto: callers may
    // reuse or mutate their row object while the operation is in flight.
    const captured: EncryptedContentEnvelope = {
      version: envelope.version,
      algorithm: envelope.algorithm,
      accountId: envelope.accountId,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
    }
    if (captured.accountId !== this.localAccountId) {
      throw new Error("Encrypted content belongs to another account.")
    }
    if (captured.version !== 1 || captured.algorithm !== "AES-256-GCM") {
      throw new Error("Encrypted content envelope is incompatible.")
    }
    const key = this.requireKey()
    const aad = contentAadText(this.databaseName, table, primaryKey, field, schemaVersion)
    return { key, aad, captured }
  }

  private cachedDecryption<T>(
    table: string,
    field: string,
    aad: string,
    captured: EncryptedContentEnvelope
  ): { value: T } | undefined {
    const cached =
      table === "sessionList" && field === "payload" ? this.sessionListCache.get(aad) : undefined
    if (
      cached &&
      cached.envelope.iv === captured.iv &&
      cached.envelope.ciphertext === captured.ciphertext
    ) {
      this.sessionListCache.delete(aad)
      this.sessionListCache.set(aad, cached)
      // Parse afresh to preserve the existing object and binary ownership
      // contract. Indexed metadata is still read and merged by the middleware.
      return {
        value: JSON.parse(cached.json, cached.needsBinaryReviver ? reviveBinary : undefined) as T,
      }
    }
    return undefined
  }

  lock(): void {
    this.key = null
    this.sessionListCache.clear()
    this.sessionListCacheBytes = 0
  }

  private cacheSessionListPayload(
    aad: string,
    envelope: EncryptedContentEnvelope,
    json: string
  ): void {
    const previous = this.sessionListCache.get(aad)
    if (previous) {
      this.sessionListCache.delete(aad)
      this.sessionListCacheBytes -= previous.bytes
    }
    // Account for all retained strings at their UTF-16 upper bound. The entry
    // cap separately bounds object overhead, including tiny payloads.
    const bytes =
      2 *
      (aad.length +
        envelope.accountId.length +
        envelope.algorithm.length +
        envelope.iv.length +
        envelope.ciphertext.length +
        json.length)
    if (bytes > SESSION_LIST_CACHE_MAX_BYTES) return
    while (
      this.sessionListCache.size >= SESSION_LIST_CACHE_MAX_ENTRIES ||
      this.sessionListCacheBytes + bytes > SESSION_LIST_CACHE_MAX_BYTES
    ) {
      const oldest = this.sessionListCache.entries().next().value!
      this.sessionListCache.delete(oldest[0])
      this.sessionListCacheBytes -= oldest[1].bytes
    }
    // Escapes may spell the binary tag without its literal key, so any escape
    // conservatively keeps the reviver. Ordinary list JSON needs no tree walk.
    const needsBinaryReviver = json.includes("\\") || json.includes('"$cogniaBytes"')
    this.sessionListCache.set(aad, { envelope, json, bytes, needsBinaryReviver })
    this.sessionListCacheBytes += bytes
  }

  private requireKey(): CryptoKey {
    if (!this.key) throw new Error("Account content cipher is locked.")
    return this.key
  }
}

let activeContentCipher: AccountContentCipher | null = null

export function activateAccountContentCipher(cipher: AccountContentCipher): void {
  activeContentCipher?.lock()
  activeContentCipher = cipher
}

export function getActiveAccountContentCipher(databaseName: string): AccountContentCipher | null {
  return activeContentCipher?.databaseName === databaseName ? activeContentCipher : null
}

export function lockAccountContentCipher(): void {
  activeContentCipher?.lock()
  activeContentCipher = null
}

export function __resetAccountContentCipherForTesting(): void {
  lockAccountContentCipher()
}

function contentAad(
  databaseName: string,
  table: string,
  primaryKey: unknown,
  field: string,
  schemaVersion: number
): Uint8Array {
  return new TextEncoder().encode(
    contentAadText(databaseName, table, primaryKey, field, schemaVersion)
  )
}

function contentAadText(
  databaseName: string,
  table: string,
  primaryKey: unknown,
  field: string,
  schemaVersion: number
): string {
  if (!table.trim() || !field.trim() || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error("Content encryption coordinates are invalid.")
  }
  return JSON.stringify(["cognia-content", databaseName, table, primaryKey, field, schemaVersion])
}

/**
 * Tag for a `Uint8Array` inside an encrypted payload. Plain `JSON.stringify`
 * turns a typed array into `{"0":35,"1":32,…}`, which read back as an object:
 * a composer draft's staged file bytes (`chatDrafts.attachments[].bytes`) came
 * back as `[object Object]`, 15 bytes of nothing. Bytes are carried as
 * base64url under this single-key tag instead and revived on decrypt. Rows
 * written before this carried the corrupted object form; those still parse as
 * the object they always were.
 *
 * Blobs remain unsupported in encrypted payloads (they cannot be read
 * synchronously); tables that hold Blobs are not `encrypted-content`.
 */
export const ENCRYPTED_BYTES_TAG = "$cogniaBytes"

function encodeBinary(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { [ENCRYPTED_BYTES_TAG]: encodeBase64Url(value) }
  return value
}

function reviveBinary(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[ENCRYPTED_BYTES_TAG] === "string" &&
    Object.keys(value).length === 1
  ) {
    return decodeBase64Url((value as Record<string, string>)[ENCRYPTED_BYTES_TAG]!)
  }
  return value
}

function randomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure random source is required.")
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto API is required.")
  return globalThis.crypto.subtle
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
