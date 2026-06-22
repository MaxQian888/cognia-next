export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/

export const ACCOUNT_REGISTRY_STATE_ID = "singleton"

export type AccountRegistryErrorCode =
  | "invalid-account-id"
  | "invalid-display-name"
  | "account-not-found"
  | "last-account"
  | "replacement-required"

export class AccountRegistryError extends Error {
  readonly code: AccountRegistryErrorCode

  constructor(code: AccountRegistryErrorCode, message: string) {
    super(message)
    this.name = "AccountRegistryError"
    this.code = code
  }
}

export interface PasswordVerifierRecord {
  algorithm: string
  salt: string
  hash: string
  params: Record<string, unknown>
}

export interface LocalAccountRecord {
  id: string
  displayName: string
  passwordVerifier: PasswordVerifierRecord
  createdAt: number
  updatedAt: number
}

export interface LegacyMigrationState {
  status: "completed"
  sourceDbName: string
  targetAccountId: string
  completedAt: number
}

export interface AccountRegistryState {
  id: typeof ACCOUNT_REGISTRY_STATE_ID
  activeAccountId: string | null
  legacyMigration?: LegacyMigrationState
  updatedAt: number
}

export function assertAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new AccountRegistryError(
      "invalid-account-id",
      "Account id must be 6-64 characters and contain only letters, numbers, underscores, or hyphens."
    )
  }
  return accountId
}

export function normalizeAccountDisplayName(displayName: string): string {
  const trimmed = displayName.trim()
  if (!trimmed) {
    throw new AccountRegistryError("invalid-display-name", "Account display name is required.")
  }
  return trimmed
}

export function clonePasswordVerifier(verifier: PasswordVerifierRecord): PasswordVerifierRecord {
  return {
    algorithm: verifier.algorithm,
    salt: verifier.salt,
    hash: verifier.hash,
    params: { ...verifier.params },
  }
}
