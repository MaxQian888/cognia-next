/**
 * Words for whatever an account sync action threw. The error classes come
 * from the API, the vault, the crypto layer, the registry check and the
 * enrollment flows; the person gets one sentence, never a stack.
 */

import { AccountSyncCryptoError } from "@/lib/account-sync/crypto"
import { EnrollmentError } from "@/lib/account-sync/enrollment/errors"
import { RegistryIntegrityError } from "@/lib/account-sync/registry-sync"
import { SyncApiError } from "@/lib/account-sync/sync-api"
import { AccountSyncVaultLockedError } from "@/lib/account-sync/vault-store"

type Translate = (key: string, values?: Record<string, string | number>) => string

export function explainSyncError(t: Translate, cause: unknown): string {
  if (cause instanceof AccountSyncVaultLockedError) return t("errors.locked")
  if (cause instanceof RegistryIntegrityError) return t("errors.integrity")
  if (cause instanceof AccountSyncCryptoError && cause.code === "recovery_mismatch")
    return t("recover.mismatch")
  if (cause instanceof EnrollmentError) {
    if (cause.code === "busy") return t("errors.busy")
    if (cause.code === "commit-mismatch") return t("approve.commitMismatch")
  }
  if (cause instanceof SyncApiError) {
    if (cause.code === "signed_out" || cause.code === "unauthorized") return t("errors.signedOut")
    if (cause.code === "network") return t("errors.network")
    if (cause.code === "space_exists") return t("setup.spaceExists")
  }
  return t("errors.generic", { message: cause instanceof Error ? cause.message : String(cause) })
}
