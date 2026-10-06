import { encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import type { CogniaDB } from "@/lib/db/schema"
import { setRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { encryptedRuntimeTargetDatabaseName } from "@/lib/runtime/target-registry"
import { __resetRoutingForTests, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"

import { ownAccountDatabase, ownDatabaseName, subscribeDatabaseAuthority } from "./own-database"

const ACCOUNT = "acct_0123456789abcdef"

const named = (name: string) => ({ name }) as CogniaDB

describe("ownAccountDatabase", () => {
  const own = named(encryptedAccountDatabaseName(ACCOUNT))
  const standalone = named(encryptedRuntimeTargetDatabaseName(ACCOUNT, "web-standalone"))
  const base = { db: () => own, target: () => null, remoteHostActive: () => false }

  it("is the plain account database on a native host (no client target)", () => {
    expect(ownAccountDatabase(ACCOUNT, base)).toBe(own)
  })

  it("is the standalone target's database in a browser or phone running on its own", () => {
    const web = { id: "web-standalone", kind: "standalone" as const }
    expect(ownAccountDatabase(ACCOUNT, { ...base, db: () => standalone, target: () => web })).toBe(
      standalone
    )
    // The plain database is not this target's.
    expect(ownAccountDatabase(ACCOUNT, { ...base, target: () => web })).toBeNull()
    const phone = named(encryptedRuntimeTargetDatabaseName(ACCOUNT, "mobile-standalone"))
    expect(
      ownAccountDatabase(ACCOUNT, {
        ...base,
        db: () => phone,
        target: () => ({ id: "mobile-standalone", kind: "standalone" }),
      })
    ).toBe(phone)
  })

  it("is null on a companion mirror, a legacy read-only target, while driving a remote host, or for another profile", () => {
    const desk = named(encryptedRuntimeTargetDatabaseName(ACCOUNT, "desk-1"))
    expect(
      ownAccountDatabase(ACCOUNT, {
        ...base,
        db: () => desk,
        target: () => ({ id: "desk-1", kind: "companion" }),
      })
    ).toBeNull()
    expect(
      ownAccountDatabase(ACCOUNT, {
        ...base,
        db: () => desk,
        target: () => ({ id: "desk-1", kind: "legacy-readonly" }),
      })
    ).toBeNull()
    expect(ownAccountDatabase(ACCOUNT, { ...base, remoteHostActive: () => true })).toBeNull()
    expect(ownAccountDatabase(ACCOUNT, { ...base, db: () => desk })).toBeNull()
    expect(ownAccountDatabase("acct_fedcba9876543210", base)).toBeNull()
  })
})

describe("ownDatabaseName", () => {
  it("names nothing for a target id no database can carry", () => {
    expect(ownDatabaseName(ACCOUNT, { id: "../x", kind: "standalone" })).toBeNull()
  })
})

describe("subscribeDatabaseAuthority", () => {
  afterEach(() => __resetRoutingForTests())

  it("hears target and remote-host changes until unsubscribed", () => {
    const listener = jest.fn()
    const stop = subscribeDatabaseAuthority(listener)
    setRuntimeSnapshot({
      target: { id: "desk-1", kind: "companion", platform: "web" },
      vaultState: "unlocked",
      connectionState: "online",
    } as never)
    expect(listener).toHaveBeenCalledTimes(1)
    setActiveRemoteTransport({} as Transport)
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    setRuntimeSnapshot({ target: null, vaultState: "unlocked", connectionState: "online" } as never)
    setActiveRemoteTransport(null)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
