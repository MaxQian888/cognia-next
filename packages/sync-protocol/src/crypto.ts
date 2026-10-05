/**
 * The WebCrypto calls the protocol needs on both sides: SHA-256, HMAC, HKDF,
 * AES-256-GCM and ECDSA P-256 over raw public points. Available alike in
 * browsers, Node, Tauri and Capacitor webviews, and Workers.
 */

import { labelled, type Label } from "./labels"

function subtle(): SubtleCrypto {
  // The bare global: Workers declare `crypto` as a const, not on `globalThis`.
  const value = typeof crypto === "undefined" ? undefined : crypto.subtle
  if (!value) throw new Error("WebCrypto is unavailable")
  return value
}

/** WebCrypto wants an `ArrayBuffer`-backed view; copying guarantees one. */
export function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", buffer(data)))
}

/** `SHA-256(label ‖ 0x00 ‖ data)`. */
export async function labelledHash(label: Label, data: Uint8Array): Promise<Uint8Array> {
  return sha256(labelled(label, data))
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await subtle().importKey(
    "raw",
    buffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return new Uint8Array(await subtle().sign("HMAC", imported, buffer(data)))
}

export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", buffer(ikm), "HKDF", false, ["deriveBits"])
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buffer(salt), info: buffer(info) },
    key,
    length * 8
  )
  return new Uint8Array(bits)
}

export async function aesGcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const imported = await subtle().importKey("raw", buffer(key), "AES-GCM", false, ["encrypt"])
  return new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: buffer(nonce), additionalData: buffer(aad) },
      imported,
      buffer(plaintext)
    )
  )
}

/** Throws when the ciphertext or its associated data was altered. */
export async function aesGcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const imported = await subtle().importKey("raw", buffer(key), "AES-GCM", false, ["decrypt"])
  return new Uint8Array(
    await subtle().decrypt(
      { name: "AES-GCM", iv: buffer(nonce), additionalData: buffer(aad) },
      imported,
      buffer(ciphertext)
    )
  )
}

/** A raw uncompressed P-256 point: 0x04 ‖ X ‖ Y. */
export const P256_POINT_BYTES = 65
export const P256_SIGNATURE_BYTES = 64

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const

export function isRawP256Point(bytes: Uint8Array): boolean {
  return bytes.length === P256_POINT_BYTES && bytes[0] === 0x04
}

/** Imports a verification key; rejects anything that is not a point on P-256. */
export async function importEcdsaPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  if (!isRawP256Point(raw)) throw new Error("not a raw uncompressed P-256 point")
  return subtle().importKey("raw", buffer(raw), ECDSA, true, ["verify"])
}

/** Imports an HPKE recipient key only to prove it is a valid P-256 point. */
export async function assertEcdhPublicKey(raw: Uint8Array): Promise<void> {
  if (!isRawP256Point(raw)) throw new Error("not a raw uncompressed P-256 point")
  await subtle().importKey("raw", buffer(raw), ECDH, true, [])
}

export async function exportRawPublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await subtle().exportKey("raw", key)) as ArrayBuffer)
}

export async function ecdsaSign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, buffer(data))
  )
}

/** Like {@link ecdsaVerify}, for a key imported once and checked many times. */
export async function ecdsaVerifyWithKey(
  publicKey: CryptoKey,
  signature: Uint8Array,
  data: Uint8Array
): Promise<boolean> {
  if (signature.length !== P256_SIGNATURE_BYTES) return false
  try {
    return await subtle().verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      buffer(signature),
      buffer(data)
    )
  } catch {
    return false
  }
}

/** False for a bad signature or a malformed key; never throws. */
export async function ecdsaVerify(
  publicKey: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array
): Promise<boolean> {
  if (signature.length !== P256_SIGNATURE_BYTES) return false
  try {
    const key = await importEcdsaPublicKey(publicKey)
    return await subtle().verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      buffer(signature),
      buffer(data)
    )
  } catch {
    return false
  }
}
