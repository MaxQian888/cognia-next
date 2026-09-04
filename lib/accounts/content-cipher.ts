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

export class AccountContentCipher implements AccountContentCipherContract {
  private key: CryptoKey | null

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
    const plaintext = new TextEncoder().encode(JSON.stringify(value))
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
    if (envelope.accountId !== this.localAccountId) {
      throw new Error("Encrypted content belongs to another account.")
    }
    if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") {
      throw new Error("Encrypted content envelope is incompatible.")
    }
    const plaintext = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: toBufferSource(decodeBase64Url(envelope.iv)),
        additionalData: toBufferSource(
          contentAad(this.databaseName, table, primaryKey, field, schemaVersion)
        ),
      },
      this.requireKey(),
      toBufferSource(decodeBase64Url(envelope.ciphertext))
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as T
  }

  lock(): void {
    this.key = null
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
  if (!table.trim() || !field.trim() || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error("Content encryption coordinates are invalid.")
  }
  return new TextEncoder().encode(
    JSON.stringify(["cognia-content", databaseName, table, primaryKey, field, schemaVersion])
  )
}

function randomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure random source is required.")
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto API is required.")
  return globalThis.crypto.subtle
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(`${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
