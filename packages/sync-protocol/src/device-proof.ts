/**
 * `Cognia-Device-Proof` (protocol §5): a request signed by the device's
 * signing key, bound to the space, the method, the path and the body, and
 * accepted for two minutes either side of the server's clock.
 */

import { fromBase64Url, fromUtf8, toBase64Url } from "./bytes"
import { ecdsaSign, ecdsaVerify, sha256 } from "./crypto"
import { isDeviceId, isRequestId } from "./ids"
import { canonicalJsonBytes } from "./jcs"
import { labelled } from "./labels"
import { PROOF_MAX_SKEW_MS } from "./limits"

export const DEVICE_PROOF_HEADER = "cognia-device-proof"
export const SERVER_TIME_HEADER = "cognia-server-time"

export interface DeviceProofPayload {
  v: 1
  spaceId: string
  /** The signing device: an enrolled `dev_` id, or a pending one. */
  deviceId: string
  method: string
  /** The request's path and query, exactly as sent. */
  path: string
  bodySha256: string
  /** Client time, ms. */
  iat: number
}

export async function bodyDigest(body: Uint8Array): Promise<string> {
  return toBase64Url(await sha256(body))
}

function signedBytes(payloadJson: Uint8Array): Uint8Array {
  return labelled("device-proof", payloadJson)
}

export async function createDeviceProof(
  payload: DeviceProofPayload,
  privateKey: CryptoKey
): Promise<string> {
  const json = canonicalJsonBytes(payload)
  const sig = await ecdsaSign(privateKey, signedBytes(json))
  return `${toBase64Url(json)}.${toBase64Url(sig)}`
}

export class DeviceProofError extends Error {
  readonly code: "bad_proof" | "clock_skew"

  constructor(code: "bad_proof" | "clock_skew", message: string) {
    super(message)
    this.name = "DeviceProofError"
    this.code = code
  }
}

export interface ParsedDeviceProof {
  payload: DeviceProofPayload
  json: Uint8Array
  sig: Uint8Array
}

/** Parses the header without checking the signature (the key depends on `deviceId`). */
export function parseDeviceProof(header: string | null | undefined): ParsedDeviceProof {
  const parts = (header ?? "").split(".")
  if (parts.length !== 2) throw new DeviceProofError("bad_proof", "malformed device proof")
  let json: Uint8Array
  let sig: Uint8Array
  let payload: unknown
  try {
    json = fromBase64Url(parts[0]!)
    sig = fromBase64Url(parts[1]!)
    payload = JSON.parse(fromUtf8(json))
  } catch {
    throw new DeviceProofError("bad_proof", "malformed device proof")
  }
  const p = payload as Partial<DeviceProofPayload>
  if (
    p.v !== 1 ||
    typeof p.spaceId !== "string" ||
    !(isDeviceId(p.deviceId) || isRequestId(p.deviceId)) ||
    typeof p.method !== "string" ||
    typeof p.path !== "string" ||
    typeof p.bodySha256 !== "string" ||
    typeof p.iat !== "number" ||
    !Number.isSafeInteger(p.iat)
  ) {
    throw new DeviceProofError("bad_proof", "malformed device proof")
  }
  // Only the canonical encoding is accepted, so one proof has one byte form.
  const canonical = canonicalJsonBytes(p)
  if (toBase64Url(canonical) !== parts[0])
    throw new DeviceProofError("bad_proof", "non-canonical device proof")
  return { payload: p as DeviceProofPayload, json, sig }
}

export interface ExpectedRequest {
  spaceId: string
  method: string
  path: string
  bodySha256: string
  now: number
}

/** Checks binding, freshness and the signature against `signPub` (raw, base64url). */
export async function verifyDeviceProof(
  proof: ParsedDeviceProof,
  signPub: string,
  expected: ExpectedRequest
): Promise<DeviceProofPayload> {
  const { payload } = proof
  if (
    payload.spaceId !== expected.spaceId ||
    payload.method !== expected.method.toUpperCase() ||
    payload.path !== expected.path ||
    payload.bodySha256 !== expected.bodySha256
  ) {
    throw new DeviceProofError("bad_proof", "the device proof is for another request")
  }
  if (Math.abs(payload.iat - expected.now) > PROOF_MAX_SKEW_MS) {
    throw new DeviceProofError("clock_skew", "the device clock is too far from the server's")
  }
  const ok = await ecdsaVerify(fromBase64Url(signPub), proof.sig, signedBytes(proof.json))
  if (!ok) throw new DeviceProofError("bad_proof", "the device proof does not verify")
  return payload
}

/** The bytes a pending device's proof of possession (`pop`) covers. */
export function enrollRequestSigningBytes(bodyWithoutPop: Record<string, unknown>): Uint8Array {
  return labelled("enroll-request", canonicalJsonBytes(bodyWithoutPop))
}
