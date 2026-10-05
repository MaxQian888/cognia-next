/**
 * Device keys (protocol §3.1): an ECDSA `signKey` and an ECDH `encKey` per
 * device, both P-256, separate from the companion pairing key. Generated once;
 * the private halves are kept as JWKs in the LocalProfile vault and only ever
 * used through non-extractable re-imports.
 */

import { isDeviceId, newDeviceId, toBase64Url } from "@cognia/sync-protocol"

import { AccountSyncCryptoError } from "./errors"
import {
  generateP256Jwk,
  importP256KeyPair,
  rawPointFromJwk,
  type P256PrivateJwk,
} from "./p256-keys"

/** What the vault stores. Contains private keys: never log or upload it. */
export interface DeviceKeyMaterial {
  v: 1
  deviceId: string
  signJwk: P256PrivateJwk
  encJwk: P256PrivateJwk
  signPub: string
  encPub: string
}

/** Ready-to-use keys: private halves non-extractable. */
export interface DeviceKeys {
  deviceId: string
  sign: CryptoKeyPair
  enc: CryptoKeyPair
  signPub: string
  encPub: string
}

export async function generateDeviceKeyMaterial(
  deviceId: string = newDeviceId()
): Promise<DeviceKeyMaterial> {
  if (!isDeviceId(deviceId)) throw new Error("not a dev_ id")
  const [signJwk, encJwk] = await Promise.all([generateP256Jwk("sign"), generateP256Jwk("enc")])
  return {
    v: 1,
    deviceId,
    signJwk,
    encJwk,
    signPub: toBase64Url(rawPointFromJwk(signJwk)),
    encPub: toBase64Url(rawPointFromJwk(encJwk)),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJwk(value: unknown, what: string): P256PrivateJwk {
  if (
    !isRecord(value) ||
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    typeof value.d !== "string" ||
    typeof value.x !== "string" ||
    typeof value.y !== "string"
  ) {
    throw new AccountSyncCryptoError("bad_key_material", `${what} is not a P-256 private key`)
  }
  return { kty: "EC", crv: "P-256", d: value.d, x: value.x, y: value.y }
}

/** Validates stored material; refuses anything this client did not write. */
export function parseDeviceKeyMaterial(value: unknown): DeviceKeyMaterial {
  if (!isRecord(value) || value.v !== 1 || !isDeviceId(value.deviceId)) {
    throw new AccountSyncCryptoError("bad_key_material", "the stored device keys are not readable")
  }
  const material: DeviceKeyMaterial = {
    v: 1,
    deviceId: value.deviceId,
    signJwk: parseJwk(value.signJwk, "the signing key"),
    encJwk: parseJwk(value.encJwk, "the encryption key"),
    signPub: String(value.signPub),
    encPub: String(value.encPub),
  }
  let signPub: string
  let encPub: string
  try {
    signPub = toBase64Url(rawPointFromJwk(material.signJwk))
    encPub = toBase64Url(rawPointFromJwk(material.encJwk))
  } catch (cause) {
    throw new AccountSyncCryptoError(
      "bad_key_material",
      "the stored device keys are not readable",
      { cause }
    )
  }
  if (signPub !== material.signPub || encPub !== material.encPub) {
    throw new AccountSyncCryptoError(
      "bad_key_material",
      "the stored public keys do not match the private keys"
    )
  }
  return material
}

export async function importDeviceKeys(material: DeviceKeyMaterial): Promise<DeviceKeys> {
  const checked = parseDeviceKeyMaterial(material)
  try {
    const [sign, enc] = await Promise.all([
      importP256KeyPair(checked.signJwk, "sign"),
      importP256KeyPair(checked.encJwk, "enc"),
    ])
    return {
      deviceId: checked.deviceId,
      sign,
      enc,
      signPub: checked.signPub,
      encPub: checked.encPub,
    }
  } catch (cause) {
    if (cause instanceof AccountSyncCryptoError) throw cause
    throw new AccountSyncCryptoError("bad_key_material", "the stored device keys do not import", {
      cause,
    })
  }
}
