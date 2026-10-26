/**
 * The plugin contract's share of `lib/plugin/character-pack/pack-trust.ts`, which re-exports these.
 */

import type { LocalCharacterPackSignature } from "../../../api/character-pack"

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
