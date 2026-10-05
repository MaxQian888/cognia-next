/**
 * P-256 key import helpers shared by device and recovery keys. Private keys
 * are always imported non-extractable; HPKE recipients are kept as key pairs
 * because `@hpke/core` can only recover the public half of a non-extractable
 * ECDH key through a fallback that guesses the sign of `y` (wrong half the
 * time), which would break `open`.
 */

import { buffer, fromBase64Url, toBase64Url } from "@cognia/sync-protocol"

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const

export type P256Use = "sign" | "enc"

function algorithm(use: P256Use) {
  return use === "sign" ? ECDSA : ECDH
}

/** A private JWK `{kty, crv, d, x, y}` without the fields WebCrypto adds. */
export interface P256PrivateJwk {
  kty: "EC"
  crv: "P-256"
  d: string
  x: string
  y: string
}

export function rawPointFromJwk(jwk: Pick<P256PrivateJwk, "x" | "y">): Uint8Array {
  const x = fromBase64Url(jwk.x)
  const y = fromBase64Url(jwk.y)
  if (x.length !== 32 || y.length !== 32) throw new Error("P-256 coordinates are 32 bytes")
  const point = new Uint8Array(65)
  point[0] = 4
  point.set(x, 1)
  point.set(y, 33)
  return point
}

export function jwkFromScalar(secretKey: Uint8Array, publicPoint: Uint8Array): P256PrivateJwk {
  if (secretKey.length !== 32 || publicPoint.length !== 65 || publicPoint[0] !== 4) {
    throw new Error("expected a 32-byte scalar and an uncompressed point")
  }
  return {
    kty: "EC",
    crv: "P-256",
    d: toBase64Url(secretKey),
    x: toBase64Url(publicPoint.subarray(1, 33)),
    y: toBase64Url(publicPoint.subarray(33)),
  }
}

/** Imports a private JWK as a key pair: private non-extractable, public raw-exportable. */
export async function importP256KeyPair(jwk: P256PrivateJwk, use: P256Use): Promise<CryptoKeyPair> {
  const alg = algorithm(use)
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y },
    alg,
    false,
    use === "sign" ? ["sign"] : ["deriveBits"]
  )
  const publicKey = await crypto.subtle.importKey(
    "raw",
    buffer(rawPointFromJwk(jwk)),
    alg,
    true,
    use === "sign" ? ["verify"] : []
  )
  return { privateKey, publicKey }
}

/** A fresh extractable key, exported once as a JWK for the vault. */
export async function generateP256Jwk(use: P256Use): Promise<P256PrivateJwk> {
  const pair = (await crypto.subtle.generateKey(
    algorithm(use),
    true,
    use === "sign" ? ["sign", "verify"] : ["deriveBits"]
  )) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error("WebCrypto exported an incomplete P-256 key")
  return { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y }
}
