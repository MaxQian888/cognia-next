/**
 * Signatures a device produces (protocol §4, §5): registry entries (by a
 * device or by the recovery key), the device proof header on requests, and a
 * pending device's proof of possession on its enrollment request.
 */

import {
  bodyDigest,
  createDeviceProof,
  ecdsaSign,
  enrollRequestSigningBytes,
  RECOVERY_SIGNER,
  signEntry,
  toBase64Url,
  type EntrySignature,
  type RegistryEntry,
  type SignedEntry,
} from "@cognia/sync-protocol"

import type { DeviceKeys } from "./device-keys"
import type { RecoveryKeyPairs } from "./recovery"

export type EntrySigner =
  { kind: "device"; keys: DeviceKeys } | { kind: "recovery"; keys: RecoveryKeyPairs }

export function signEntryAs(entry: RegistryEntry, signer: EntrySigner): Promise<EntrySignature> {
  return signer.kind === "device"
    ? signEntry(entry, signer.keys.deviceId, signer.keys.sign.privateKey)
    : signEntry(entry, RECOVERY_SIGNER, signer.keys.sign.privateKey)
}

/** Signs `entry` with each signer, in the order given. */
export async function signRegistryEntry(
  entry: RegistryEntry,
  signers: readonly EntrySigner[]
): Promise<SignedEntry> {
  return { entry, sigs: await Promise.all(signers.map((signer) => signEntryAs(entry, signer))) }
}

export interface ProofRequest {
  spaceId: string
  method: string
  /** Path and query exactly as sent. */
  path: string
  /** The exact body bytes; empty for a request without one. */
  body?: Uint8Array
  /** Client time corrected by the server-time offset, ms. */
  now: number
}

/** The `Cognia-Device-Proof` header value for one request. */
export async function deviceProofHeader(keys: DeviceKeys, request: ProofRequest): Promise<string> {
  return createDeviceProof(
    {
      v: 1,
      spaceId: request.spaceId,
      deviceId: keys.deviceId,
      method: request.method.toUpperCase(),
      path: request.path,
      bodySha256: await bodyDigest(request.body ?? new Uint8Array()),
      iat: Math.round(request.now),
    },
    keys.sign.privateKey
  )
}

/** `pop`: the pending device's signature over its request body without `pop`. */
export async function enrollRequestPop(
  keys: DeviceKeys,
  bodyWithoutPop: Record<string, unknown>
): Promise<string> {
  return toBase64Url(
    await ecdsaSign(keys.sign.privateKey, enrollRequestSigningBytes(bodyWithoutPop))
  )
}
