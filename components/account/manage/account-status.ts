/**
 * Pure derivation of a local account's session status, shared by the manage
 * dialog's list rows and detail header. Keeping it a plain function (no store,
 * no React) makes the branch-heavy logic trivially unit-testable and keeps the
 * UI components presentational.
 */

export type AccountStatus = "active" | "unlocked" | "locked"

/**
 * Resolve how a given account relates to the current session:
 * - `active`   — it is the active account (its database is mounted).
 * - `unlocked` — its password was verified this session but it is not active.
 * - `locked`   — neither active nor unlocked; a password is required to switch.
 */
export function accountStatus(
  accountId: string,
  activeAccountId: string | null,
  unlockedAccountId: string | null
): AccountStatus {
  if (accountId === activeAccountId) return "active"
  if (accountId === unlockedAccountId) return "unlocked"
  return "locked"
}

/** i18n key suffix (under `account.manage`) for a status pill label. */
export const ACCOUNT_STATUS_LABEL_KEY: Record<AccountStatus, string> = {
  active: "statusActive",
  unlocked: "statusUnlocked",
  locked: "statusLocked",
}
