// Zero-knowledge AES-GCM for share payloads.
//
// Unlike `lib/data/crypto.ts` (PBKDF2-from-passphrase, for backups), a share's
// key is a raw random 256-bit value carried in the URL `#fragment`. The base
// case imports that key directly. When the user opts into an *extra* passphrase,
// the AES key is derived from PBKDF2 over (rawKey ‖ passphrase) — so neither the
// URL key nor the passphrase alone can decrypt. Web Crypto only; runs in the
// app webview, Capacitor, and a plain browser viewer alike.

import { sha256Hex } from "./hash"
import { encodeBase64, decodeBase64 } from "./encoding"
import type { ShareEnvelopeV1, SharePayload } from "./types"

const PASSPHRASE_PBKDF2_ITERATIONS = 600_000

/** Thrown when the decrypted plaintext fails its SHA-256 integrity check. */
export class ShareIntegrityError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super("Share integrity check failed: the content was truncated or tampered with")
    this.name = "ShareIntegrityError"
  }
}

/** Thrown when an envelope requires a passphrase but none was supplied. */
export class SharePassphraseRequiredError extends Error {
  constructor() {
    super("This share is passphrase-protected")
    this.name = "SharePassphraseRequiredError"
  }
}

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is required but not available in this runtime")
  }
  return subtle
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes) as BufferSource
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function randomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random source is not available in this runtime")
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

async function importRawAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return getSubtle().importKey("raw", toBufferSource(rawKey), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ])
}

/** Bind the URL key and the passphrase together into a single AES key. */
async function derivePassphraseKey(
  rawKey: Uint8Array,
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const subtle = getSubtle()
  const passphraseBytes = new TextEncoder().encode(passphrase)
  const material = new Uint8Array(rawKey.length + passphraseBytes.length)
  material.set(rawKey, 0)
  material.set(passphraseBytes, rawKey.length)

  const keyMaterial = await subtle.importKey("raw", toBufferSource(material), "PBKDF2", false, [
    "deriveKey",
  ])
  return subtle.deriveKey(
    { name: "PBKDF2", salt: toBufferSource(salt), iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

/**
 * Encrypt a payload into an opaque envelope. `kind` and `mime` ride inside the
 * ciphertext, so the storage server only ever sees `{iv, ciphertext, checksum}`.
 */
export async function encryptSharePayload(
  payload: SharePayload,
  rawKey: Uint8Array,
  passphrase?: string
): Promise<ShareEnvelopeV1> {
  const subtle = getSubtle()
  const plainText = JSON.stringify(payload)
  const iv = randomBytes(12)

  let key: CryptoKey
  let pp: ShareEnvelopeV1["pp"]
  if (passphrase) {
    const salt = randomBytes(16)
    key = await derivePassphraseKey(rawKey, passphrase, salt, PASSPHRASE_PBKDF2_ITERATIONS)
    pp = {
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: PASSPHRASE_PBKDF2_ITERATIONS,
      salt: encodeBase64(salt),
    }
  } else {
    key = await importRawAesKey(rawKey)
  }

  const encrypted = await subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    key,
    toBufferSource(new TextEncoder().encode(plainText))
  )

  return {
    v: 1,
    alg: "AES-GCM",
    ...(pp ? { pp } : {}),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(encrypted)),
    checksum: await sha256Hex(plainText),
  }
}

/**
 * Decrypt an envelope back into a payload, verifying integrity afterwards.
 * Throws {@link SharePassphraseRequiredError} when the envelope needs a
 * passphrase that wasn't supplied, {@link ShareIntegrityError} on checksum
 * mismatch, and lets WebCrypto's `OperationError` surface for a wrong key /
 * wrong passphrase (the caller maps that to "this link is invalid").
 */
export async function decryptShareEnvelope(
  envelope: ShareEnvelopeV1,
  rawKey: Uint8Array,
  passphrase?: string
): Promise<SharePayload> {
  const subtle = getSubtle()
  const iv = decodeBase64(envelope.iv)
  const ciphertext = decodeBase64(envelope.ciphertext)

  let key: CryptoKey
  if (envelope.pp) {
    if (!passphrase) throw new SharePassphraseRequiredError()
    key = await derivePassphraseKey(
      rawKey,
      passphrase,
      decodeBase64(envelope.pp.salt),
      envelope.pp.iterations
    )
  } else {
    key = await importRawAesKey(rawKey)
  }

  const decrypted = await subtle.decrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    key,
    toBufferSource(ciphertext)
  )
  const plainText = new TextDecoder().decode(decrypted)

  const checksum = await sha256Hex(plainText)
  if (checksum !== envelope.checksum) {
    throw new ShareIntegrityError(envelope.checksum, checksum)
  }
  return JSON.parse(plainText) as SharePayload
}

/** Does this envelope demand a passphrase? Lets the viewer prompt up-front. */
export function envelopeRequiresPassphrase(envelope: ShareEnvelopeV1): boolean {
  return envelope.pp != null
}
