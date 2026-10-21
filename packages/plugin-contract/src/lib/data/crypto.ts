/**
 * The plugin contract's share of `lib/data/crypto.ts`, which re-exports these.
 */
export interface BackupChunkEncryptionConfig {
  enabled: true
  format: "aes-gcm-chunks-v1"
  algorithm: "AES-GCM"
  kdf: {
    algorithm: "PBKDF2"
    hash: "SHA-256"
    iterations: number
    salt: string
  }
  /** Base64-encoded eight-byte prefix; the record sequence supplies four more IV bytes. */
  noncePrefix: string
}
