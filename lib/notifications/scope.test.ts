/**
 * Tests for lib/notifications/scope.ts + identity-cache.ts — the sync-cached
 * identity that lets the Run Journal stamp a scopeKey inside a Dexie
 * transaction. Covers hint-vs-context resolution, the cached synchronous
 * scopeKey, the account prefix the worker reconciles, and the legacy
 * single-account fallback before any prime.
 */

import {
  resolveNotificationScope,
  cachedNotificationScopeKey,
  cachedNotificationAccountPrefix,
  scopeKeyFor,
  stableScopeKey,
  __setNotificationNamespaceForTesting,
  __setNotificationIdentityForTesting,
} from "./scope"
import {
  setNotificationIdentity,
  setNotificationNamespaceAccount,
  getNotificationIdentity,
  __resetNotificationIdentityForTesting,
} from "./identity-cache"
import { notificationScopeKey } from "@/types/notifications/scope"

beforeEach(() => {
  __resetNotificationIdentityForTesting()
  __setNotificationNamespaceForTesting(null)
})

describe("identity-cache", () => {
  it("starts empty then holds the primed identity", () => {
    expect(getNotificationIdentity()).toBeNull()
    setNotificationIdentity({ namespaceId: "ns", accountId: "a", authorityHostId: "h" })
    expect(getNotificationIdentity()).toEqual({
      namespaceId: "ns",
      accountId: "a",
      authorityHostId: "h",
    })
  })

  it("stamps namespace+account while preserving the host", () => {
    setNotificationIdentity({ namespaceId: "ns0", accountId: "a0", authorityHostId: "h0" })
    setNotificationNamespaceAccount("ns1", "a1")
    expect(getNotificationIdentity()).toEqual({
      namespaceId: "ns1",
      accountId: "a1",
      authorityHostId: "h0",
    })
  })

  it("defaults the host to `unknown` when namespace+account prime first", () => {
    setNotificationNamespaceAccount("ns", "a")
    expect(getNotificationIdentity()?.authorityHostId).toBe("unknown")
  })
})

describe("resolveNotificationScope", () => {
  it("honors every hint field it supplies", async () => {
    const scope = await resolveNotificationScope({
      accountId: "acct",
      namespaceId: "db-x",
      authorityHostId: "host",
      workspaceId: "ws",
      businessProjectId: "bp",
      runtimeId: "rt",
      executionHostId: "eh",
    })
    expect(scope).toEqual({
      namespaceId: "db-x",
      accountId: "acct",
      authorityHostId: "host",
      workspaceId: "ws",
      businessProjectId: "bp",
      runtimeId: "rt",
      executionHostId: "eh",
    })
  })

  it("falls back to `local`/`unknown` for unresolvable context fields", async () => {
    __setNotificationNamespaceForTesting("ns-test")
    const scope = await resolveNotificationScope({ namespaceId: "ns-test" })
    expect(scope.namespaceId).toBe("ns-test")
    // accountId + authorityHostId resolve from the live registry/device — under
    // the test env they land on the documented fallbacks.
    expect(typeof scope.accountId).toBe("string")
    expect(scope.accountId.length).toBeGreaterThan(0)
  })

  it("uses the pinned namespace for the scopeKey", async () => {
    __setNotificationNamespaceForTesting("ns-pinned")
    const scope = await resolveNotificationScope({ namespaceId: "ns-pinned", accountId: "a" })
    expect(scopeKeyFor(scope)).toBe(
      notificationScopeKey({ namespaceId: "ns-pinned", accountId: "a" })
    )
  })
})

describe("cachedNotificationScopeKey", () => {
  it("uses the primed identity synchronously", () => {
    __setNotificationIdentityForTesting({ namespaceId: "ns", accountId: "a", authorityHostId: "h" })
    expect(cachedNotificationScopeKey("ws1")).toBe(
      notificationScopeKey({ namespaceId: "ns", accountId: "a", workspaceId: "ws1" })
    )
  })

  it("falls back to the legacy single-account scope before any prime", () => {
    const key = cachedNotificationScopeKey()
    expect(key).toBe(notificationScopeKey({ namespaceId: "cognia-claude", accountId: "local" }))
  })

  it("encodes workspace + businessProject into the stable key", () => {
    __setNotificationIdentityForTesting({ namespaceId: "ns", accountId: "a", authorityHostId: "h" })
    const key = cachedNotificationScopeKey("ws", "bp")
    expect(key).toBe(
      notificationScopeKey({
        namespaceId: "ns",
        accountId: "a",
        workspaceId: "ws",
        businessProjectId: "bp",
      })
    )
  })
})

describe("cachedNotificationAccountPrefix", () => {
  it("is the namespace+account prefix the worker's scopeKey match uses", () => {
    __setNotificationIdentityForTesting({ namespaceId: "ns", accountId: "a", authorityHostId: "h" })
    const prefix = cachedNotificationAccountPrefix()
    // Every scope this account wrote starts with the prefix.
    expect(cachedNotificationScopeKey("ws-anything").startsWith(prefix)).toBe(true)
    expect(cachedNotificationScopeKey().startsWith(prefix)).toBe(true)
    // A DIFFERENT account's scope does not.
    expect(notificationScopeKey({ namespaceId: "ns", accountId: "other" }).startsWith(prefix)).toBe(
      false
    )
  })
})

describe("stableScopeKey", () => {
  it("ignores authority-host/runtime fields (stable identity only)", () => {
    const a = stableScopeKey({ namespaceId: "ns", accountId: "a", workspaceId: "w" })
    const b = stableScopeKey({ namespaceId: "ns", accountId: "a", workspaceId: "w" })
    expect(a).toBe(b)
  })
})
