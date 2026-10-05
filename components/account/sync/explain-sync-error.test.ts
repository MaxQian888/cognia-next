import { AccountSyncCryptoError } from "@/lib/account-sync/crypto"
import { EnrollmentError } from "@/lib/account-sync/enrollment/errors"
import { RegistryIntegrityError } from "@/lib/account-sync/registry-sync"
import { SyncApiError } from "@/lib/account-sync/sync-api"
import { AccountSyncVaultLockedError } from "@/lib/account-sync/vault-store"

import { explainSyncError } from "./explain-sync-error"

const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}:${JSON.stringify(values)}` : key

describe("explainSyncError", () => {
  it.each([
    [new AccountSyncVaultLockedError(), "errors.locked"],
    [new RegistryIntegrityError("rollback", "x"), "errors.integrity"],
    [new AccountSyncCryptoError("recovery_mismatch", "x"), "recover.mismatch"],
    [new EnrollmentError("busy", "x"), "errors.busy"],
    [new EnrollmentError("commit-mismatch", "x"), "approve.commitMismatch"],
    [new SyncApiError("signed_out", 401, "x"), "errors.signedOut"],
    [new SyncApiError("unauthorized", 401, "x"), "errors.signedOut"],
    [new SyncApiError("network", 0, "x"), "errors.network"],
    [new SyncApiError("space_exists", 409, "x"), "setup.spaceExists"],
  ])("explains %p", (cause, key) => {
    expect(explainSyncError(t, cause)).toBe(key)
  })

  it("falls back to the message", () => {
    expect(explainSyncError(t, new Error("boom"))).toBe('errors.generic:{"message":"boom"}')
    expect(explainSyncError(t, "odd")).toBe('errors.generic:{"message":"odd"}')
  })
})
