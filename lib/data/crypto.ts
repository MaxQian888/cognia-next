// AES-GCM + PBKDF2-SHA256 + SHA-256 helpers for the v3 backup format.
//
// Web Crypto API only. `globalThis.crypto.subtle` is available in every
// modern browser, in Capacitor's WebView, and in Node 20+ test runtimes —
// so there is no Node-specific fallback. Importing `node:crypto` would
// only force bundlers to add a polyfill the mobile bundle never needs.

import type { EncryptedEnvelopeV1, BackupManifestV3 } from "./types"
import { IntegrityCheckFailedError } from "./types"

const PBKDF2_ITERATIONS = 600_000

export interface BackupChunkEncryptionConfig {
  enabled: true
  format: "aes-gcm-chunks-v1"
  algorithm: "AES-GCM"
  kdf: {
    algorithm: "PBKDF2"
    hash: "SHA-256"
    iterations: number
    salt: string
  }
  /** Base64-encoded eight-byte prefix; the record sequence supplies four more IV bytes. */
  noncePrefix: string
}

export interface BackupChunkCipher {
  config: BackupChunkEncryptionConfig
  seal(sequence: number, plainText: string, additionalData: string): Promise<string>
  open(sequence: number, cipherText: string, additionalData: string): Promise<string>
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = ""
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }
    return btoa(binary)
  }
  return Buffer.from(bytes).toString("base64")
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes) as BufferSource
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is required but not available in this runtime")
  }
  return subtle
}

async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  const subtle = getSubtleCrypto()
  const digest = await subtle.digest("SHA-256", toBufferSource(input))
  return new Uint8Array(digest)
}

/** Hex-encoded SHA-256 of a UTF-8 string. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await sha256Bytes(new TextEncoder().encode(value))
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const subtle = getSubtleCrypto()
  const keyMaterial = await subtle.importKey(
    "raw",
    toBufferSource(new TextEncoder().encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  )

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toBufferSource(salt),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

function chunkIv(prefix: Uint8Array, sequence: number): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff) {
    throw new RangeError("Backup chunk sequence exceeds the AES-GCM nonce range")
  }
  if (prefix.length !== 8) throw new TypeError("Backup chunk nonce prefix must be eight bytes")
  const iv = new Uint8Array(12)
  iv.set(prefix)
  new DataView(iv.buffer).setUint32(8, sequence)
  return iv
}

/** Create a record-level cipher whose deterministic IVs remain unique within one backup. */
export async function createBackupChunkCipher(
  passphrase: string,
  existing?: BackupChunkEncryptionConfig
): Promise<BackupChunkCipher> {
  const salt = existing ? decodeBase64(existing.kdf.salt) : randomBytes(16)
  const noncePrefix = existing ? decodeBase64(existing.noncePrefix) : randomBytes(8)
  const iterations = existing?.kdf.iterations ?? PBKDF2_ITERATIONS
  if (salt.length !== 16) throw new TypeError("Backup chunk KDF salt must be sixteen bytes")
  if (noncePrefix.length !== 8) {
    throw new TypeError("Backup chunk nonce prefix must be eight bytes")
  }
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) {
    throw new RangeError("Backup chunk PBKDF2 iteration count is outside the supported range")
  }
  const key = await deriveAesKey(passphrase, salt, iterations)
  const config: BackupChunkEncryptionConfig = existing ?? {
    enabled: true,
    format: "aes-gcm-chunks-v1",
    algorithm: "AES-GCM",
    kdf: {
      algorithm: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: encodeBase64(salt),
    },
    noncePrefix: encodeBase64(noncePrefix),
  }

  const crypt = async (
    mode: "encrypt" | "decrypt",
    sequence: number,
    value: string,
    additionalData: string
  ): Promise<string> => {
    const subtle = getSubtleCrypto()
    const params: AesGcmParams = {
      name: "AES-GCM",
      iv: toBufferSource(chunkIv(noncePrefix, sequence)),
      additionalData: toBufferSource(new TextEncoder().encode(additionalData)),
    }
    if (mode === "encrypt") {
      const result = await subtle.encrypt(
        params,
        key,
        toBufferSource(new TextEncoder().encode(value))
      )
      return encodeBase64(new Uint8Array(result))
    }
    const result = await subtle.decrypt(params, key, toBufferSource(decodeBase64(value)))
    return new TextDecoder().decode(result)
  }

  return {
    config,
    seal: (sequence, plainText, additionalData) =>
      crypt("encrypt", sequence, plainText, additionalData),
    open: (sequence, cipherText, additionalData) =>
      crypt("decrypt", sequence, cipherText, additionalData),
  }
}

function randomBytes(length: number): Uint8Array {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length))
  }
  throw new Error("Secure random source is not available in this runtime")
}

/**
 * Wrap a serialized BackupPackageV3 plaintext in an `EncryptedEnvelopeV1`.
 * Caller is responsible for stringifying the package; we sign the bytes
 * verbatim so re-serialization quirks can never invalidate the checksum.
 */
export async function encryptBackupPackage(
  plainText: string,
  passphrase: string,
  manifest: Omit<BackupManifestV3, "integrity">
): Promise<EncryptedEnvelopeV1> {
  const subtle = getSubtleCrypto()
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveAesKey(passphrase, salt)
  const encrypted = await subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    key,
    toBufferSource(new TextEncoder().encode(plainText))
  )

  return {
    version: "enc-v1",
    algorithm: "AES-GCM",
    kdf: {
      algorithm: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: encodeBase64(salt),
    },
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(encrypted)),
    manifest,
    checksum: await sha256Hex(plainText),
  }
}

/**
 * Decrypt an `EncryptedEnvelopeV1`, verifying the checksum afterwards.
 * Throws `IntegrityCheckFailedError` if the recomputed SHA-256 doesn't match
 * the stored checksum (file was truncated / tampered with). A wrong passphrase
 * surfaces as the WebCrypto-thrown `OperationError`, not as our error type —
 * the caller decides how to surface that.
 */
export async function decryptBackupPackage(
  envelope: EncryptedEnvelopeV1,
  passphrase: string
): Promise<string> {
  const subtle = getSubtleCrypto()
  const salt = decodeBase64(envelope.kdf.salt)
  const iv = decodeBase64(envelope.iv)
  const ciphertext = decodeBase64(envelope.ciphertext)
  const key = await deriveAesKey(passphrase, salt, envelope.kdf.iterations)
  const decrypted = await subtle.decrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    key,
    toBufferSource(ciphertext)
  )

  const plainText = new TextDecoder().decode(decrypted)
  const checksum = await sha256Hex(plainText)
  if (checksum !== envelope.checksum) {
    throw new IntegrityCheckFailedError(envelope.checksum, checksum)
  }

  return plainText
}

export const __TESTING__ = { PBKDF2_ITERATIONS }
