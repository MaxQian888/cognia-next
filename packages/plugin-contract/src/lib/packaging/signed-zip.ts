/**
 * The plugin contract's share of `lib/packaging/signed-zip.ts`, which re-exports these.
 */
export interface PackageSignature {
  algorithm: "ed25519"
  /** Display name of the signer. */
  publisher: string
  /** Base64 raw 32-byte Ed25519 public key. */
  publicKey: string
  /** Base64 raw 64-byte Ed25519 signature over the canonical manifest. */
  signature: string
}

export interface PackageFileRecord {
  path: string
  sha256: string
  size?: number
}
