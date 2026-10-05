/** Why a key operation of Account Sync (ADR-0215 phase 2) was refused. */
export type AccountSyncCryptoErrorCode =
  /** Stored key material is not in the shape this client wrote. */
  | "bad_key_material"
  /** An HPKE envelope or sealed name does not open, or is addressed elsewhere. */
  | "bad_envelope"
  /** An opened key does not match the commitment in the signed registry. */
  | "key_commitment"
  /** The typed recovery key derives keys other than the registry's. */
  | "recovery_mismatch"

export class AccountSyncCryptoError extends Error {
  readonly code: AccountSyncCryptoErrorCode

  constructor(code: AccountSyncCryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "AccountSyncCryptoError"
    this.code = code
  }
}
