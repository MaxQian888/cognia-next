/**
 * Headless account bootstrap (ADR-0059 T-B3).
 *
 * @jest-environment node
 */
import { installFakeIndexedDb } from "@/lib/headless/node-indexeddb"
import { encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import { getActiveAccountContentCipher } from "@/lib/accounts/content-cipher"
import {
  clearPartitionArtifactKeyBase,
  hasPartitionArtifactKeys,
} from "@/lib/accounts/partition-artifact-keys"
import { unlockAccountForHost, useAccountStore } from "@/stores/account/account-store"

import { ensureHeadlessAccount, HEADLESS_LOCAL_ACCOUNT_ID } from "./account"

describe("unlockAccountForHost guard", () => {
  it("refuses without the headless marker", async () => {
    delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
    await expect(unlockAccountForHost("local_acct_a")).rejects.toThrow(
      /reserved for headless host processes/
    )
  })
})

describe("ensureHeadlessAccount", () => {
  beforeAll(async () => {
    await installFakeIndexedDb()
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    process.env.COGNIA_ACCOUNT_CONTENT_KEY = "33".repeat(32)
  })

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
    delete process.env.COGNIA_ACCOUNT_CONTENT_KEY
  })

  it("creates, activates, and host-unlocks the account (idempotently)", async () => {
    const id = await ensureHeadlessAccount()
    expect(id).toBe(HEADLESS_LOCAL_ACCOUNT_ID)
    expect(useAccountStore.getState().unlockedAccountId).toBe(HEADLESS_LOCAL_ACCOUNT_ID)
    expect(useAccountStore.getState().locked).toBe(false)
    expect(
      getActiveAccountContentCipher(encryptedAccountDatabaseName(HEADLESS_LOCAL_ACCOUNT_ID))
    ).not.toBeNull()

    // Second boot: the account exists — no duplicate, still unlocked.
    const again = await ensureHeadlessAccount()
    expect(again).toBe(HEADLESS_LOCAL_ACCOUNT_ID)
    expect(useAccountStore.getState().unlockedAccountId).toBe(HEADLESS_LOCAL_ACCOUNT_ID)
  })

  it("installs a partition artifact key base only for a person brain", async () => {
    clearPartitionArtifactKeyBase()
    process.env.COGNIA_ACCOUNT_CONTENT_KEY = "33".repeat(32)
    await ensureHeadlessAccount("local_acct_operator")
    expect(hasPartitionArtifactKeys("local_acct_operator")).toBe(false)

    const injected = new Uint8Array(32).fill(0x44)
    await ensureHeadlessAccount("local_acct_person", {
      accountContentKey: injected,
      partitionArtifactKeys: true,
    })
    expect(hasPartitionArtifactKeys("local_acct_person")).toBe(true)
    // An injected key stays the caller's: the base holds its own copy.
    expect(injected.every((byte) => byte === 0x44)).toBe(true)
    clearPartitionArtifactKeyBase()
    process.env.COGNIA_ACCOUNT_CONTENT_KEY = "33".repeat(32)
  })

  it("fails closed when the supervisor did not provide a content key", async () => {
    delete process.env.COGNIA_ACCOUNT_CONTENT_KEY
    await expect(ensureHeadlessAccount("local_acct_missing_key")).rejects.toThrow(
      /COGNIA_ACCOUNT_CONTENT_KEY/
    )
    process.env.COGNIA_ACCOUNT_CONTENT_KEY = "33".repeat(32)
  })
})
