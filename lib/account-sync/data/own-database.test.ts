import { encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import type { CogniaDB } from "@/lib/db/schema"
import { setRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

import { ownAccountDatabase, subscribeDatabaseAuthority } from "./own-database"

const ACCOUNT = "acct_0123456789abcdef"

const named = (name: string) => ({ name }) as CogniaDB

describe("ownAccountDatabase", () => {
  const own = named(encryptedAccountDatabaseName(ACCOUNT))

  it("is the active database when it is the profile's own", () => {
    const found = ownAccountDatabase(ACCOUNT, {
      db: () => own,
      targetKind: () => null,
      remoteHostActive: () => false,
    })
    expect(found).toBe(own)
  })

  it("is null on a companion mirror, while driving a remote host, or for another profile", () => {
    const base = { db: () => own, targetKind: () => null, remoteHostActive: () => false }
    expect(ownAccountDatabase(ACCOUNT, { ...base, targetKind: () => "companion" })).toBeNull()
    expect(ownAccountDatabase(ACCOUNT, { ...base, remoteHostActive: () => true })).toBeNull()
    expect(
      ownAccountDatabase(ACCOUNT, {
        ...base,
        db: () => named(`${encryptedAccountDatabaseName(ACCOUNT)}-target-desk`),
      })
    ).toBeNull()
    expect(ownAccountDatabase("acct_fedcba9876543210", base)).toBeNull()
    // A standalone target is this device's own data.
    expect(ownAccountDatabase(ACCOUNT, { ...base, targetKind: () => "standalone" })).toBe(own)
  })
})

describe("subscribeDatabaseAuthority", () => {
  it("hears target and runtime changes until unsubscribed", () => {
    const listener = jest.fn()
    const stop = subscribeDatabaseAuthority(listener)
    setActiveRuntimeTargetContext(ACCOUNT, "desk-1")
    setRuntimeSnapshot({ target: null, vaultState: "unlocked", connectionState: "online" } as never)
    const heard = listener.mock.calls.length
    expect(heard).toBeGreaterThanOrEqual(2)
    stop()
    clearActiveRuntimeTargetContext()
    expect(listener).toHaveBeenCalledTimes(heard)
  })
})
