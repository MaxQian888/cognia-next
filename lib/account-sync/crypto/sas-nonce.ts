/**
 * Approval-code nonces (protocol §5.2). Both live in memory only: the new
 * device's `nonceR` until it is revealed, the approver's `nonceA` until the
 * code is shown. An approver must compute the code from the nonce it
 * generated, never from one the server echoes back.
 */

import {
  SAS_NONCE_BYTES,
  formatSasCode,
  randomBytes,
  sasCode,
  sasCommit,
  type SasTranscript,
} from "@cognia/sync-protocol"

/** The new device's secret: posted as `commit` first, revealed after the approver's nonce is in. */
export interface RequesterNonce {
  nonceR: Uint8Array
  commit: string
}

export async function newRequesterNonce(): Promise<RequesterNonce> {
  const nonceR = randomBytes(SAS_NONCE_BYTES)
  return { nonceR, commit: await sasCommit(nonceR) }
}

export function newApproverNonce(): Uint8Array {
  return randomBytes(SAS_NONCE_BYTES)
}

/** The six digits as both screens show them (`123 456`). */
export async function displayedSasCode(
  nonceR: Uint8Array,
  nonceA: Uint8Array,
  transcript: SasTranscript
): Promise<string> {
  return formatSasCode(await sasCode(nonceR, nonceA, transcript))
}

/** Overwrites a nonce once it is no longer needed. */
export function wipeNonce(nonce: Uint8Array): void {
  nonce.fill(0)
}
