/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "./schema"
import {
  getEntryContext,
  getWebSession,
  markEntryContextConsumed,
  pruneExpiredEntryContexts,
  recordEntryContext,
  revokeWebSession,
  touchWebSession,
} from "./lark-entry"

const T0 = 1_753_000_000_000

describe("lark-entry ledgers", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("records, consumes, and prunes entry contexts", async () => {
    await recordEntryContext({
      jti: "jti_1",
      adapterId: "lk-1",
      principalId: "fp_1",
      accountId: "acct_a",
      entryType: "bot_menu",
      conversationKey: "lark:lk-1:oc_1",
      expiresAt: T0 + 300_000,
      now: T0,
    })
    await markEntryContextConsumed("jti_1", T0 + 1000)
    expect((await getEntryContext("jti_1"))?.consumedAt).toBe(T0 + 1000)
    // Unknown jtis are a silent no-op (companion may report late).
    await markEntryContextConsumed("jti_missing")

    await recordEntryContext({
      jti: "jti_stale",
      adapterId: "lk-1",
      principalId: "fp_1",
      accountId: "acct_a",
      entryType: "group_menu",
      conversationKey: "lark:lk-1:oc_2",
      expiresAt: T0 + 1,
      now: T0,
    })
    // Consumed rows survive the prune; stale unconsumed rows are reaped.
    expect(await pruneExpiredEntryContexts(T0 + 400_000)).toBe(1)
    expect(await getEntryContext("jti_stale")).toBeUndefined()
    expect(await getEntryContext("jti_1")).toBeDefined()
  })

  it("upserts and revokes web-session ledger rows", async () => {
    const first = await touchWebSession({
      jtiHash: "abc123",
      adapterId: "lk-1",
      openIdHash: "deadbeef",
      tenantKey: "tk_a",
      appId: "cli_1",
      issuedAt: T0,
      expiresAt: T0 + 8 * 3600_000,
      now: T0,
    })
    expect(first.lastSeenAt).toBe(T0)

    const second = await touchWebSession({
      jtiHash: "abc123",
      adapterId: "lk-1",
      openIdHash: "deadbeef",
      tenantKey: "tk_a",
      appId: "cli_1",
      principalId: "fp_9",
      issuedAt: T0,
      expiresAt: T0 + 8 * 3600_000,
      now: T0 + 5000,
    })
    expect(second.lastSeenAt).toBe(T0 + 5000)
    expect(second.principalId).toBe("fp_9")
    expect(await getDb().larkWebSessions.count()).toBe(1)

    await revokeWebSession("abc123", T0 + 9000)
    expect((await getWebSession("abc123"))?.revokedAt).toBe(T0 + 9000)
  })
})

describe("default clock arms", () => {
  it("every accessor works without an explicit now", async () => {
    await recordEntryContext({
      jti: "jti_now",
      adapterId: "lk-1",
      principalId: "fp_1",
      accountId: "acct_a",
      entryType: "bot_menu",
      conversationKey: "lark:lk-1:oc_1",
      expiresAt: Date.now() + 60_000,
    })
    await markEntryContextConsumed("jti_now")
    expect((await getEntryContext("jti_now"))?.consumedAt).toBeGreaterThan(0)
    // Unknown jti no-ops on the same default-arm path.
    await markEntryContextConsumed("jti_missing")
    expect(await pruneExpiredEntryContexts()).toBe(0)
    await touchWebSession({
      jtiHash: "ws_now",
      adapterId: "lk-1",
      openIdHash: "hash",
      tenantKey: "tk_a",
      appId: "cli_1",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    await revokeWebSession("ws_now")
    await revokeWebSession("ws_missing")
  })
})
