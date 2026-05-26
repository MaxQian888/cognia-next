// Coverage for the share-link local-mirror CRUD layer.

import "fake-indexeddb/auto"
import {
  recordSharedLink,
  listSharedLinks,
  getSharedLinkByCode,
  markSharedLinkRevoked,
  deleteSharedLink,
  pruneExpiredSharedLinks,
  type SharedLinkRow,
} from "./shared-links"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().sharedLinks.clear()
})

function input(code: string, partial: Partial<SharedLinkRow> = {}) {
  return {
    code,
    kind: "chat-html" as const,
    url: `https://share.example/v/${code}#k=abc`,
    createdAt: Date.now(),
    burnAfterRead: false,
    hasPassphrase: false,
    ...partial,
  }
}

describe("recordSharedLink", () => {
  it("inserts a row with a generated id and defaults revoked to false", async () => {
    const row = await recordSharedLink(input("AAA"))
    expect(row.id).toMatch(/^sl_/)
    expect(row.revoked).toBe(false)
    expect(await getSharedLinkByCode("AAA")).toMatchObject({ code: "AAA", revoked: false })
  })
})

describe("listSharedLinks", () => {
  it("returns newest-first and hides revoked rows by default", async () => {
    await recordSharedLink(input("OLD", { createdAt: 1 }))
    await recordSharedLink(input("NEW", { createdAt: 2 }))
    await recordSharedLink(input("GONE", { createdAt: 3, revoked: true }))

    const visible = await listSharedLinks()
    expect(visible.map((r) => r.code)).toEqual(["NEW", "OLD"])

    const all = await listSharedLinks({ includeRevoked: true })
    expect(all.map((r) => r.code)).toEqual(["GONE", "NEW", "OLD"])
  })
})

describe("markSharedLinkRevoked / deleteSharedLink", () => {
  it("flips the revoke flag", async () => {
    await recordSharedLink(input("X"))
    await markSharedLinkRevoked("X")
    expect((await getSharedLinkByCode("X"))?.revoked).toBe(true)
  })

  it("deletes a row by code", async () => {
    await recordSharedLink(input("Y"))
    await deleteSharedLink("Y")
    expect(await getSharedLinkByCode("Y")).toBeUndefined()
  })
})

describe("pruneExpiredSharedLinks", () => {
  it("removes only rows whose expiry is in the past", async () => {
    await recordSharedLink(input("EXPIRED", { expiresAt: 1000 }))
    await recordSharedLink(input("LIVE", { expiresAt: 9_000_000_000_000 }))
    await recordSharedLink(input("FOREVER")) // no expiresAt

    const removed = await pruneExpiredSharedLinks(2000)
    expect(removed).toBe(1)
    expect((await listSharedLinks()).map((r) => r.code).sort()).toEqual(["FOREVER", "LIVE"])
  })
})
