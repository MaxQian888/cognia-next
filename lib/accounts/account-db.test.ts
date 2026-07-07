import "fake-indexeddb/auto"

import {
  ACCOUNT_REGISTRY_DB_NAME,
  CogniaAccountRegistryDB,
  LocalAccountRegistry,
  accountDatabaseName,
} from "./account-db"
import type { PasswordVerifierRecord } from "./account-types"

const verifier: PasswordVerifierRecord = {
  algorithm: "test-only",
  salt: "salt",
  hash: "hash",
  params: { iterations: 1 },
}

function registryName(testName: string) {
  return `${ACCOUNT_REGISTRY_DB_NAME}-${testName.replace(/[^a-z0-9_-]/gi, "-")}`
}

async function freshRegistry(testName: string) {
  const name = registryName(testName)
  const cleanup = new CogniaAccountRegistryDB(name)
  await cleanup.delete()
  const db = new CogniaAccountRegistryDB(name)
  return { db, registry: new LocalAccountRegistry(db) }
}

describe("LocalAccountRegistry", () => {
  it("creates the first account, activates it, and derives its physical Dexie name", async () => {
    const { db, registry } = await freshRegistry("first-account")

    const account = await registry.createAccount({
      id: "acct_legacy",
      displayName: "  Legacy User  ",
      passwordVerifier: verifier,
      now: 1000,
    })

    expect(account).toMatchObject({
      id: "acct_legacy",
      displayName: "Legacy User",
      createdAt: 1000,
      updatedAt: 1000,
      passwordVerifier: verifier,
    })
    await expect(registry.listAccounts()).resolves.toEqual([account])
    await expect(registry.getActiveAccountId()).resolves.toBe("acct_legacy")
    expect(accountDatabaseName(account.id)).toBe("cognia-account-acct_legacy")

    db.close()
  })

  it("keeps the active account stable when adding another account until switched", async () => {
    const { db, registry } = await freshRegistry("switch-account")
    await registry.createAccount({
      id: "acct_one",
      displayName: "One",
      passwordVerifier: verifier,
      now: 1,
    })
    await registry.createAccount({
      id: "acct_two",
      displayName: "Two",
      passwordVerifier: verifier,
      activate: false,
      now: 2,
    })

    await expect(registry.getActiveAccountId()).resolves.toBe("acct_one")

    await registry.setActiveAccountId("acct_two", 3)

    await expect(registry.getActiveAccountId()).resolves.toBe("acct_two")
    await expect(registry.setActiveAccountId("acct_missing", 4)).rejects.toThrow(/does not exist/i)

    db.close()
  })

  it("renames accounts with validation and monotonic updatedAt", async () => {
    const { db, registry } = await freshRegistry("rename-account")
    await registry.createAccount({
      id: "acct_one",
      displayName: "One",
      passwordVerifier: verifier,
      now: 10,
    })

    await expect(registry.renameAccount("acct_one", "  Personal  ", 20)).resolves.toMatchObject({
      id: "acct_one",
      displayName: "Personal",
      updatedAt: 20,
    })
    await expect(registry.renameAccount("acct_one", " ", 30)).rejects.toThrow(/display name/i)
    await expect(registry.renameAccount("acct_missing", "Missing", 30)).rejects.toThrow(
      /does not exist/i
    )

    db.close()
  })

  it("updates the password verifier with validation and monotonic updatedAt", async () => {
    const { db, registry } = await freshRegistry("update-verifier")
    await registry.createAccount({
      id: "acct_one",
      displayName: "One",
      passwordVerifier: verifier,
      now: 10,
    })

    const nextVerifier: PasswordVerifierRecord = {
      algorithm: "argon2id-v1",
      salt: "salt-2",
      hash: "hash-2",
      params: { iterations: 2 },
    }

    await expect(
      registry.updatePasswordVerifier("acct_one", nextVerifier, 20)
    ).resolves.toMatchObject({
      id: "acct_one",
      displayName: "One",
      passwordVerifier: nextVerifier,
      updatedAt: 20,
    })
    await expect(registry.listAccounts()).resolves.toEqual([
      expect.objectContaining({ passwordVerifier: nextVerifier }),
    ])
    await expect(registry.updatePasswordVerifier("acct_missing", nextVerifier, 30)).rejects.toThrow(
      /does not exist/i
    )

    db.close()
  })

  it("sets and clears the account avatar with monotonic updatedAt", async () => {
    const { db, registry } = await freshRegistry("update-avatar")
    await registry.createAccount({
      id: "acct_one",
      displayName: "One",
      passwordVerifier: verifier,
      now: 10,
    })

    const dataUrl = "data:image/png;base64,AAAA"
    await expect(registry.updateAvatar("acct_one", dataUrl, 20)).resolves.toMatchObject({
      id: "acct_one",
      avatarDataUrl: dataUrl,
      updatedAt: 20,
    })
    await expect(registry.listAccounts()).resolves.toEqual([
      expect.objectContaining({ avatarDataUrl: dataUrl }),
    ])

    // Whitespace-only clears the avatar back to the glyph fallback.
    const cleared = await registry.updateAvatar("acct_one", "   ", 30)
    expect(cleared.avatarDataUrl).toBeUndefined()
    expect(cleared.updatedAt).toBe(30)

    // Null also clears; monotonic updatedAt bumps past a stale timestamp.
    await registry.updateAvatar("acct_one", dataUrl, 40)
    const nulled = await registry.updateAvatar("acct_one", null, 35)
    expect(nulled.avatarDataUrl).toBeUndefined()
    expect(nulled.updatedAt).toBe(41)

    await expect(registry.updateAvatar("acct_missing", dataUrl, 50)).rejects.toThrow(
      /does not exist/i
    )

    db.close()
  })

  it("does not delete the last account and requires a replacement when deleting the active account", async () => {
    const { db, registry } = await freshRegistry("delete-account")
    await registry.createAccount({
      id: "acct_one",
      displayName: "One",
      passwordVerifier: verifier,
      now: 1,
    })

    await expect(registry.deleteAccount("acct_one", { now: 2 })).rejects.toThrow(/last account/i)

    await registry.createAccount({
      id: "acct_two",
      displayName: "Two",
      passwordVerifier: verifier,
      activate: false,
      now: 3,
    })
    await expect(registry.deleteAccount("acct_one", { now: 4 })).rejects.toThrow(/replacement/i)

    await registry.deleteAccount("acct_one", { replacementAccountId: "acct_two", now: 5 })

    await expect(registry.listAccounts()).resolves.toEqual([
      expect.objectContaining({ id: "acct_two" }),
    ])
    await expect(registry.getActiveAccountId()).resolves.toBe("acct_two")

    db.close()
  })

  it("records legacy migration completion only for an existing account", async () => {
    const { db, registry } = await freshRegistry("legacy-migration")
    await registry.createAccount({
      id: "acct_legacy",
      displayName: "Legacy",
      passwordVerifier: verifier,
      now: 1,
    })

    await expect(
      registry.markLegacyMigrationCompleted({
        sourceDbName: "cognia-claude",
        targetAccountId: "acct_missing",
        completedAt: 2,
      })
    ).rejects.toThrow(/does not exist/i)

    await registry.markLegacyMigrationCompleted({
      sourceDbName: "cognia-claude",
      targetAccountId: "acct_legacy",
      completedAt: 3,
    })

    await expect(registry.getState()).resolves.toMatchObject({
      activeAccountId: "acct_legacy",
      legacyMigration: {
        status: "completed",
        sourceDbName: "cognia-claude",
        targetAccountId: "acct_legacy",
        completedAt: 3,
      },
    })

    db.close()
  })

  it("generates an account id with crypto.randomUUID when no id is provided", async () => {
    const originalCrypto = globalThis.crypto
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    })
    const { db, registry } = await freshRegistry("generated-crypto-id")

    const account = await registry.createAccount({
      displayName: "Generated",
      passwordVerifier: verifier,
      now: 1,
    })

    expect(account.id).toBe("acct_111111112222333344445555")
    await expect(registry.getActiveAccountId()).resolves.toBe(account.id)

    db.close()
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto })
  })

  it("falls back to timestamp and Math.random when crypto.randomUUID is unavailable", async () => {
    const originalCrypto = globalThis.crypto
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.123456789)
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} })
    const { db, registry } = await freshRegistry("generated-fallback-id")

    const account = await registry.createAccount({
      displayName: "Fallback",
      passwordVerifier: verifier,
    })

    expect(account.id).toBe("acct_loyw3v28_4fzzzxjylr")
    expect(accountDatabaseName(account.id)).toBe("cognia-account-acct_loyw3v28_4fzzzxjylr")

    db.close()
    randomSpy.mockRestore()
    nowSpy.mockRestore()
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto })
  })

  it("rejects unsafe account ids before deriving a database name", () => {
    expect(() => accountDatabaseName("acct ok")).toThrow(/account id/i)
    expect(() => accountDatabaseName("../acct")).toThrow(/account id/i)
    expect(() => accountDatabaseName("acct-ok_123")).not.toThrow()
  })
})
