// AES-GCM + PBKDF2-SHA256 + SHA-256 helpers for the v3 backup format.
//
// Adapted directly from Cognia's `lib/storage/persistence/crypto.ts`. Works in
// both the browser (`globalThis.crypto.subtle`) and Node's test runtime
// (`node:crypto`'s `webcrypto.subtle`).

import type { EncryptedEnvelopeV1, BackupManifestV3 } from "./types"
import { IntegrityCheckFailedError } from "./types"

const PBKDF2_ITERATIONS = 600_000

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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function getSubtleCrypto(): Promise<SubtleCrypto> {
  if (globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle
  }
  const { webcrypto } = await import("node:crypto")
  return webcrypto.subtle as unknown as SubtleCrypto
}

async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  const subtle = await getSubtleCrypto()
  const digest = await subtle.digest("SHA-256", toArrayBuffer(input))
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
  const subtle = await getSubtleCrypto()
  const keyMaterial = await subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  )

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
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
  const subtle = await getSubtleCrypto()
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveAesKey(passphrase, salt)
  const encrypted = await subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(new TextEncoder().encode(plainText))
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
  const subtle = await getSubtleCrypto()
  const salt = decodeBase64(envelope.kdf.salt)
  const iv = decodeBase64(envelope.iv)
  const ciphertext = decodeBase64(envelope.ciphertext)
  const key = await deriveAesKey(passphrase, salt, envelope.kdf.iterations)
  const decrypted = await subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext)
  )

  const plainText = new TextDecoder().decode(decrypted)
  const checksum = await sha256Hex(plainText)
  if (checksum !== envelope.checksum) {
    throw new IntegrityCheckFailedError(envelope.checksum, checksum)
  }

  return plainText
}

export const __TESTING__ = { PBKDF2_ITERATIONS }
