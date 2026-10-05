/**
 * The six-digit approval code (protocol §5.2), commit-then-reveal: the new
 * device commits to `nonceR` before the approver picks `nonceA`, and reveals
 * it only after. A server that substitutes keys then has one 10^-6 chance per
 * attempt the person can see, instead of grinding codes offline.
 */

import { bytesEqual, concatBytes, fromBase64Url, toBase64Url } from "./bytes"
import { hkdf, labelledHash, sha256 } from "./crypto"
import { canonicalJsonBytes } from "./jcs"
import { labelled } from "./labels"
import type { DevicePlatform } from "./registry/types"

export const SAS_NONCE_BYTES = 32

export async function sasCommit(nonceR: Uint8Array): Promise<string> {
  return toBase64Url(await labelledHash("sas-commit", nonceR))
}

export async function matchesSasCommit(nonceR: Uint8Array, commit: string): Promise<boolean> {
  return bytesEqual(await labelledHash("sas-commit", nonceR), fromBase64Url(commit))
}

/** What both screens' code binds. Each side fills it from its own values. */
export interface SasTranscript {
  spaceId: string
  genesisHash: string
  requestId: string
  deviceId: string
  platform: DevicePlatform
  signPub: string
  encPub: string
  commit: string
  approverDeviceId: string
}

export function transcriptBytes(transcript: SasTranscript): Uint8Array {
  return canonicalJsonBytes({ v: 1, ...transcript })
}

/** `transcriptHash` in the approving `add-device` entry. */
export async function transcriptHash(transcript: SasTranscript): Promise<string> {
  return toBase64Url(await sha256(transcriptBytes(transcript)))
}

/** The six digits, as a string with leading zeros. */
export async function sasCode(
  nonceR: Uint8Array,
  nonceA: Uint8Array,
  transcript: SasTranscript
): Promise<string> {
  if (nonceR.length !== SAS_NONCE_BYTES || nonceA.length !== SAS_NONCE_BYTES) {
    throw new Error("approval nonces are 32 bytes")
  }
  const salt = await labelledHash("sas", transcriptBytes(transcript))
  const bytes = await hkdf(concatBytes(nonceR, nonceA), salt, labelled("sas-digits"), 8)
  // uint64be(bytes) mod 10^6, in safe-integer arithmetic: (hi·2^32 + lo) mod 10^6.
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8)
  const hi = view.getUint32(0)
  const lo = view.getUint32(4)
  const value =
    ((((hi % 1_000_000) * (2 ** 32 % 1_000_000)) % 1_000_000) + (lo % 1_000_000)) % 1_000_000
  return value.toString().padStart(6, "0")
}

/** `123456` → `123 456`. */
export function formatSasCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}
