/**
 * The plugin contract's share of `lib/rag/profile-dek-store.ts`, which re-exports these.
 */
import type { BackupChunkEncryptionConfig } from "../data/crypto"

export interface PortableProfileDekEnvelopeV1 {
  version: 1
  profileId: string
  keyId: string
  encryption: BackupChunkEncryptionConfig
  ciphertext: string
}
