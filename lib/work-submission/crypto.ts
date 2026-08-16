/**
 * Encryption for the frozen halves of a work submission (ADR-0123).
 *
 * Nothing here is new cryptography. It composes two existing authorities:
 *
 *   • `loadOrCreateAccountArtifactKey` (`lib/ai/eval/artifact-crypto.ts`) for
 *     account-scoped key provisioning — OS keyring on desktop and the headless
 *     brain, Browser Vault on the web.
 *   • `encryptContentEnvelope` / `decryptContentEnvelope` (`@cognia/rag`) for
 *     the AES-256-GCM envelope, already the shape persisted by
 *     `retrievalEncryptedContent`.
 *
 * The one decision this module makes is the **AAD**. Each envelope is bound to
 * `account : submission : kind`, so a ciphertext cannot be transplanted onto a
 * different submission, a different half of the same submission, or another
 * account — decryption fails instead of silently replaying someone else's
 * input. That matters more here than elsewhere: the whole point of freezing an
 * input is that a retry replays *that* input and no other.
 */

import {
  decryptContentEnvelope,
  encryptContentEnvelope,
  type EncryptedContentEnvelopeV1,
} from "@cognia/rag"

import { loadOrCreateAccountArtifactKey } from "@/lib/ai/eval/artifact-crypto"

/** Which frozen half an envelope holds. Part of the AAD, so the two cannot swap. */
export type WorkSubmissionPayloadKind = "input-batch" | "context-bundle"

export const WORK_SUBMISSION_KEY_ID = "work-submission-v1"

export interface WorkSubmissionCryptoScope {
  accountId: string
  submissionId: string
  kind: WorkSubmissionPayloadKind
}

/** Injection seam for tests and for hosts that resolve keys differently. */
export interface WorkSubmissionCryptoDeps {
  loadKey?: (accountId: string) => Promise<Uint8Array>
}

export function workSubmissionAad(scope: WorkSubmissionCryptoScope): string {
  return `work-submission-v1:${scope.accountId}:${scope.submissionId}:${scope.kind}`
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function importKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required for work submission encryption")
  }
  return globalThis.crypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, [
    usage,
  ])
}

async function resolveKey(
  accountId: string,
  usage: KeyUsage,
  deps: WorkSubmissionCryptoDeps
): Promise<CryptoKey> {
  const raw = deps.loadKey
    ? await deps.loadKey(accountId)
    : await loadOrCreateAccountArtifactKey(accountId, "work-submission")
  return importKey(raw, usage)
}

/**
 * Seal a frozen payload.
 *
 * `payload` is serialized with a stable key order by the caller when a digest
 * is also being taken, so the digest and the ciphertext describe the same
 * bytes.
 */
export async function sealWorkSubmissionPayload(
  plainText: string,
  scope: WorkSubmissionCryptoScope,
  deps: WorkSubmissionCryptoDeps = {}
): Promise<EncryptedContentEnvelopeV1> {
  const key = await resolveKey(scope.accountId, "encrypt", deps)
  return encryptContentEnvelope(plainText, {
    key,
    keyId: WORK_SUBMISSION_KEY_ID,
    additionalData: workSubmissionAad(scope),
  })
}

/**
 * Open a frozen payload.
 *
 * Throws when the envelope was sealed for a different account, submission, or
 * half — the AAD mismatch is a decryption failure, not a silent wrong answer.
 */
export async function openWorkSubmissionPayload(
  envelope: EncryptedContentEnvelopeV1,
  scope: WorkSubmissionCryptoScope,
  deps: WorkSubmissionCryptoDeps = {}
): Promise<string> {
  const key = await resolveKey(scope.accountId, "decrypt", deps)
  return decryptContentEnvelope(envelope, {
    key,
    additionalData: workSubmissionAad(scope),
  })
}
