/**
 * Typed unlock failures.
 *
 * The unlock path used to surface `Error.message` straight to the lock screen,
 * so the user read hard-coded English sentences the UI could never translate —
 * and, worse, raw Web Crypto `OperationError`s: a mistyped Browser Vault
 * password fails as an AES-GCM tag mismatch, which says nothing at all.
 *
 * Every failure the lock screen can present is a code here. `codeOf` is the one
 * classifier both the store and the UI go through, so an untyped error from a
 * layer below still lands on a translatable bucket instead of leaking prose.
 */

export type AccountUnlockErrorCode =
  /** The password (or recovery key) did not decrypt / verify. */
  | "invalid-password"
  /** Nothing was typed. */
  | "password-required"
  /** A recovery key was supplied but is not 32 bytes of base64url. */
  | "invalid-recovery-key"
  /** No Browser Vault row exists for this account — a desktop-created account
   *  opened in a browser, or a partially deleted profile. */
  | "vault-not-provisioned"
  /** The stored vault record predates the current KDF parameters. */
  | "vault-incompatible"
  /** Too many failed attempts; the caller must wait out the cooldown. */
  | "throttled"
  /** The local database was written by a storage layout this build cannot open.
   *  The data is intact on disk; the only way forward is an explicit reset. */
  | "storage-layout-unsupported"
  /** Anything else — the message is still logged, never shown verbatim. */
  | "unknown"

export class AccountUnlockError extends Error {
  readonly code: AccountUnlockErrorCode

  constructor(code: AccountUnlockErrorCode, message?: string) {
    super(message ?? code)
    this.name = "AccountUnlockError"
    this.code = code
  }
}

/** Web Crypto reports a wrong AES-GCM key as a bare `OperationError`. */
function isDecryptionFailure(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "OperationError"
  }
  return error instanceof Error && error.name === "OperationError"
}

/**
 * Bucket any thrown value into a code the lock screen can translate.
 *
 * Ordering matters: an explicit `AccountUnlockError` always wins, then the
 * crypto-level signal, and only then the legacy message shapes that older
 * layers still throw as plain `Error`s.
 */
export function codeOf(error: unknown): AccountUnlockErrorCode {
  if (error instanceof AccountUnlockError) return error.code
  // Matched by name rather than by `instanceof`, so this module stays free of
  // an import from the db layer (which imports the vault, which imports this).
  if (error instanceof Error && error.name === "UnsupportedLocalSchemaError") {
    return "storage-layout-unsupported"
  }
  if (isDecryptionFailure(error)) return "invalid-password"
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  if (/invalid local account password/i.test(message)) return "invalid-password"
  if (/password is required/i.test(message)) return "password-required"
  if (/recovery key is malformed/i.test(message)) return "invalid-recovery-key"
  if (/not provisioned for this account/i.test(message)) return "vault-not-provisioned"
  if (/record is incompatible|verifier is not supported/i.test(message)) return "vault-incompatible"
  if (/was not written by this build/i.test(message)) return "storage-layout-unsupported"
  return "unknown"
}

/** Re-throw as a typed error, preserving the original as `cause` for logs. */
export function asUnlockError(error: unknown): AccountUnlockError {
  if (error instanceof AccountUnlockError) return error
  const typed = new AccountUnlockError(
    codeOf(error),
    error instanceof Error ? error.message : String(error)
  )
  ;(typed as { cause?: unknown }).cause = error
  return typed
}
