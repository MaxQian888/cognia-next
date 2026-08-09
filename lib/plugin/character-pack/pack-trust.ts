/**
 * Runtime trust state for a Character Pack.
 *
 * Two states, deliberately. There is no `"invalid"`:
 *
 * - `verified` — the file carried a signature and it checked out.
 * - `unsigned` — the file carried no signature. Still fully usable; unsigned
 *   packs remain supported indefinitely and are simply labelled.
 *
 * A pack that carries a signature which does NOT verify is neither. It is
 * refused at the door and never reaches the registry, so the type cannot
 * represent the one lie that matters: a tampered pack shown as merely unsigned.
 * That is why {@link resolvePackTrust} returns a discriminated result rather
 * than a trust value — the caller is forced to handle refusal.
 */

import { verifyPackPayloadSignature } from "@/lib/plugin/security/signature"
import { shortFingerprint } from "@/lib/plugin/security/signature"

import { canonicalPackString } from "./canonical-json"
import type { LocalCharacterPackFile, LocalCharacterPackSignature } from "./schema"

export type CharacterPackTrust =
  | {
      state: "verified"
      algo: "ed25519"
      /** base64, exactly as it appeared in the file. */
      publicKey: string
      /** sha256 hex of the public key. */
      fingerprint: string
      /** `ed25519:9f:3a:…` for display. */
      shortFingerprint: string
      /**
       * The ORIGINAL signature block, retained verbatim so `exportPack` can
       * write it back out unchanged and the exported file still verifies.
       */
      signature: LocalCharacterPackSignature
    }
  | { state: "unsigned" }

export const UNSIGNED_TRUST: CharacterPackTrust = { state: "unsigned" }

export type ResolvePackTrustResult =
  { ok: true; trust: CharacterPackTrust } | { ok: false; reason: string }

/**
 * Recompute trust for a parsed pack file.
 *
 * Fails closed. `reason: "host-unavailable"` is `ok: false` too — if we cannot
 * check a signature that is present, we do not get to assume it was fine.
 * (Unreachable in practice: `importLocalPack` guards on Tauri and the scan
 * no-ops without an app data dir. Specified anyway so the invariant survives
 * a refactor that moves those guards.)
 */
export async function resolvePackTrust(
  file: LocalCharacterPackFile
): Promise<ResolvePackTrustResult> {
  const signature = file.signature
  if (!signature) {
    return { ok: true, trust: UNSIGNED_TRUST }
  }

  let payload: string
  try {
    payload = canonicalPackString(file.pack)
  } catch (error) {
    // A pack that cannot be canonicalised cannot be verified, and it carries a
    // signature, so it is refused rather than downgraded.
    return {
      ok: false,
      reason: `canonicalization failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const verdict = await verifyPackPayloadSignature({
    packId: file.pack.id,
    packVersion: file.pack.version,
    payload,
    signatureBase64: signature.sig,
    publicKeyBase64: signature.pubKey,
  })

  if (!verdict.verified) {
    return { ok: false, reason: verdict.reason ?? "signature-mismatch" }
  }

  return {
    ok: true,
    trust: {
      state: "verified",
      algo: "ed25519",
      publicKey: signature.pubKey,
      fingerprint: verdict.fingerprint,
      shortFingerprint: shortFingerprint(verdict.fingerprint),
      signature,
    },
  }
}
