/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "./schema"
import {
  getEntryContext,
  getWebSession,
  markEntryContextConsumed,
  listWebSessions,
  pruneExpiredEntryContexts,
  pruneExpiredWebSessions,
  recordEntryContext,
  revokeWebSession,
  revokeWebSessionsForPrincipal,
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

  it("lists an adapter's sessions newest-sighting first and ignores other adapters", async () => {
    const base = {
      openIdHash: "hash_a",
      tenantKey: "tk_a",
      appId: "cli_1",
      issuedAt: T0,
      expiresAt: T0 + 3_600_000,
    }
    await touchWebSession({ ...base, jtiHash: "ws_old", adapterId: "lk-1", now: T0 })
    await touchWebSession({ ...base, jtiHash: "ws_new", adapterId: "lk-1", now: T0 + 5_000 })
    await touchWebSession({ ...base, jtiHash: "ws_other", adapterId: "lk-2", now: T0 + 9_000 })

    expect((await listWebSessions("lk-1")).map((row) => row.id)).toEqual(["ws_new", "ws_old"])
    expect((await listWebSessions("lk-2")).map((row) => row.id)).toEqual(["ws_other"])
    expect(await listWebSessions("lk-missing")).toEqual([])
  })

  it("keeps the principal attached once a later sighting learns it", async () => {
    const base = {
      jtiHash: "ws_1",
      adapterId: "lk-1",
      openIdHash: "hash_a",
      tenantKey: "tk_a",
      appId: "cli_1",
      issuedAt: T0,
      expiresAt: T0 + 3_600_000,
    }
    // The import / plus intents record a sighting before the principal is
    // resolved; a later resolve_surface supplies it and must not be undone.
    await touchWebSession({ ...base, now: T0 })
    expect((await getWebSession("ws_1"))?.principalId).toBeUndefined()
    await touchWebSession({ ...base, principalId: "fp_1", now: T0 + 1_000 })
    await touchWebSession({ ...base, now: T0 + 2_000 })
    const row = await getWebSession("ws_1")
    expect(row?.principalId).toBe("fp_1")
    expect(row?.lastSeenAt).toBe(T0 + 2_000)
  })

  it("revokes every live session of one principal and leaves the rest alone", async () => {
    const base = {
      adapterId: "lk-1",
      openIdHash: "hash_a",
      tenantKey: "tk_a",
      appId: "cli_1",
      issuedAt: T0,
      expiresAt: T0 + 3_600_000,
      now: T0,
    }
    await touchWebSession({ ...base, jtiHash: "ws_a", principalId: "fp_1" })
    await touchWebSession({ ...base, jtiHash: "ws_b", principalId: "fp_1" })
    await touchWebSession({ ...base, jtiHash: "ws_c", principalId: "fp_2" })
    await touchWebSession({ ...base, jtiHash: "ws_d" })
    await revokeWebSession("ws_b", T0 + 1)

    // Already-revoked rows keep their original stamp — the audit fact is when
    // access stopped, not when the sweep last ran.
    expect(await revokeWebSessionsForPrincipal("fp_1", T0 + 500)).toBe(1)
    expect((await getWebSession("ws_a"))?.revokedAt).toBe(T0 + 500)
    expect((await getWebSession("ws_b"))?.revokedAt).toBe(T0 + 1)
    expect((await getWebSession("ws_c"))?.revokedAt).toBeUndefined()
    expect((await getWebSession("ws_d"))?.revokedAt).toBeUndefined()
    expect(await revokeWebSessionsForPrincipal("fp_missing", T0 + 500)).toBe(0)
  })

  it("prunes only sessions past the retention window, not merely expired ones", async () => {
    const base = {
      adapterId: "lk-1",
      openIdHash: "hash_a",
      tenantKey: "tk_a",
      appId: "cli_1",
      issuedAt: T0,
      now: T0,
    }
    const day = 24 * 60 * 60 * 1000
    await touchWebSession({ ...base, jtiHash: "ws_live", expiresAt: T0 + 60_000 })
    await touchWebSession({ ...base, jtiHash: "ws_recent", expiresAt: T0 - day })
    await touchWebSession({ ...base, jtiHash: "ws_ancient", expiresAt: T0 - 40 * day })

    // A just-expired session is the interesting one right after an incident.
    expect(await pruneExpiredWebSessions(30 * day, T0)).toBe(1)
    expect(await getWebSession("ws_ancient")).toBeUndefined()
    expect(await getWebSession("ws_recent")).toBeDefined()
    expect(await getWebSession("ws_live")).toBeDefined()
    expect(await pruneExpiredWebSessions(30 * day, T0)).toBe(0)
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
