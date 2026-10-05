/**
 * The sync recovery key (protocol §3.2): 16 random bytes shown as Crockford
 * base32. It deterministically derives two P-256 key pairs, `recoveryEnc`
 * (the HPKE recipient every epoch key is also sealed to) and `recoverySign`
 * (which countersigns recovery adds and recovery-key changes).
 *
 * Scalars come from RFC 9180 §7.1.3 `DeriveKeyPair` for DHKEM(P-256), done
 * here with `@noble/hashes` and `@noble/curves`, so the public point is
 * computed rather than recovered and the key imports as a complete JWK.
 */

import { p256 } from "@noble/curves/nist.js"
import { expand, extract } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"

import {
  RECOVERY_KEY_BYTES,
  concatBytes,
  hkdf,
  labelled,
  randomBytes,
  toBase64Url,
  utf8,
  type RecoveryKeys as RegistryRecoveryKeys,
} from "@cognia/sync-protocol"

import { AccountSyncCryptoError } from "./errors"
import { importP256KeyPair, jwkFromScalar } from "./p256-keys"

/** `"KEM" ‖ I2OSP(0x0010, 2)`: DHKEM(P-256, HKDF-SHA256). */
const KEM_SUITE_ID = concatBytes(utf8("KEM"), new Uint8Array([0x00, 0x10]))
const HPKE_V1 = utf8("HPKE-v1")
const NSK = 32

function labeledExtract(salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return extract(sha256, concatBytes(HPKE_V1, KEM_SUITE_ID, utf8(label), ikm), salt)
}

function labeledExpand(
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number
): Uint8Array {
  const prefix = new Uint8Array([(length >> 8) & 0xff, length & 0xff])
  return expand(sha256, prk, concatBytes(prefix, HPKE_V1, KEM_SUITE_ID, utf8(label), info), length)
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = BigInt(0)
  for (const byte of bytes) value = (value << BigInt(8)) | BigInt(byte)
  return value
}

/** RFC 9180 §7.1.3 `DeriveKeyPair` for DHKEM(P-256, HKDF-SHA256): bitmask 0xff, candidate counter. */
export function deriveP256KeyPair(ikm: Uint8Array): {
  secretKey: Uint8Array
  publicKey: Uint8Array
} {
  const order = p256.Point.Fn.ORDER
  const prk = labeledExtract(new Uint8Array(), "dkp_prk", ikm)
  for (let counter = 0; counter <= 255; counter++) {
    const candidate = labeledExpand(prk, "candidate", new Uint8Array([counter]), NSK)
    candidate[0] = candidate[0]! & 0xff
    const scalar = bytesToBigInt(candidate)
    if (scalar !== BigInt(0) && scalar < order) {
      return { secretKey: candidate, publicKey: p256.getPublicKey(candidate, false) }
    }
  }
  throw new Error("DeriveKeyPair found no valid P-256 scalar")
}

export function newRecoveryKey(): Uint8Array {
  return randomBytes(RECOVERY_KEY_BYTES)
}

export interface RecoveryKeyPairs {
  sign: CryptoKeyPair
  enc: CryptoKeyPair
  signPub: string
  encPub: string
}

/** Derives the recovery key pairs of `spaceId` from the 16-byte recovery key. */
export async function deriveRecoveryKeys(
  recoveryKey: Uint8Array,
  spaceId: string
): Promise<RecoveryKeyPairs> {
  if (recoveryKey.length !== RECOVERY_KEY_BYTES)
    throw new Error(`a recovery key is ${RECOVERY_KEY_BYTES} bytes`)
  const seed = await hkdf(recoveryKey, utf8(spaceId), labelled("recovery"), 32)
  const pairs = await Promise.all(
    (["recovery-enc", "recovery-sign"] as const).map(async (label) => {
      const ikm = expand(sha256, seed, labelled(label), 32)
      const { secretKey, publicKey } = deriveP256KeyPair(ikm)
      const jwk = jwkFromScalar(secretKey, publicKey)
      ikm.fill(0)
      secretKey.fill(0)
      return { publicKey: toBase64Url(publicKey), jwk }
    })
  )
  seed.fill(0)
  const [enc, sign] = pairs as [(typeof pairs)[number], (typeof pairs)[number]]
  return {
    enc: await importP256KeyPair(enc.jwk, "enc"),
    sign: await importP256KeyPair(sign.jwk, "sign"),
    encPub: enc.publicKey,
    signPub: sign.publicKey,
  }
}

/** Refuses a recovery key that is not the one this space's registry holds. */
export function assertRecoveryKeysMatch(
  derived: RecoveryKeyPairs,
  registry: RegistryRecoveryKeys
): void {
  if (derived.signPub !== registry.signPub || derived.encPub !== registry.encPub) {
    throw new AccountSyncCryptoError(
      "recovery_mismatch",
      "this recovery key does not belong to this account"
    )
  }
}
