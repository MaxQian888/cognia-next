/**
 * How far a cogpack's signer can be trusted, under the user's plugin policy
 * (ADR-0209).
 *
 * The signer is a publisher key, the same kind of key that signs WASM plugins
 * and template packages, and it lands in the same `trustedPublishers` ledger.
 * The policy's two flags apply as they do to plugins: "signatures required"
 * refuses an unsigned cogpack, "trusted publishers only" also refuses one
 * signed by a key the user has not accepted. Otherwise the import proceeds,
 * with the trust shown so the user decides with it in view.
 */

import { trustPublisher } from "@/lib/db/trusted-publishers"
import { readPolicy } from "@/lib/plugin/core/plugins-policy-storage"
import { isPublisherKeyTrusted } from "@/lib/plugin/package/http-installer"
import { publisherFingerprint } from "@/lib/templates/publisher-identity"
import type { CogpackSignature, CogpackTrust } from "@/types/plugin/plugin-cogset"

export type CogpackTrustRefusal = "signature-required" | "trusted-publishers-only"

export interface CogpackTrustResult {
  trust: CogpackTrust
  /** Set when the policy forbids importing this cogpack. */
  refusedBy?: CogpackTrustRefusal
  /** SHA-256 hex of the signer's raw key, for display. */
  fingerprint?: string
}

export interface CogpackTrustDeps {
  isTrusted: (publicKey: string) => Promise<boolean>
  readPolicy: () => { signatureRequired: boolean; trustedPublishersOnly: boolean }
  fingerprint: (publicKey: string) => Promise<string>
}

const defaultDeps: CogpackTrustDeps = {
  isTrusted: isPublisherKeyTrusted,
  readPolicy,
  fingerprint: publisherFingerprint,
}

export async function resolveCogpackTrust(
  signature: CogpackSignature | undefined,
  deps: CogpackTrustDeps = defaultDeps
): Promise<CogpackTrustResult> {
  const policy = deps.readPolicy()
  if (!signature) {
    return {
      trust: "unsigned",
      ...(policy.signatureRequired || policy.trustedPublishersOnly
        ? { refusedBy: policy.signatureRequired ? "signature-required" : "trusted-publishers-only" }
        : {}),
    }
  }
  const fingerprint = await deps.fingerprint(signature.publicKey)
  if (await deps.isTrusted(signature.publicKey)) return { trust: "trusted", fingerprint }
  return {
    trust: "signed-unknown",
    fingerprint,
    ...(policy.trustedPublishersOnly ? { refusedBy: "trusted-publishers-only" as const } : {}),
  }
}

/** Accept the signer, so its cogpacks, plugins and templates are trusted from now on. */
export async function trustCogpackSigner(signature: CogpackSignature): Promise<void> {
  await trustPublisher({
    publicKey: signature.publicKey,
    fingerprint: await publisherFingerprint(signature.publicKey),
    authorName: signature.publisher,
  })
}
