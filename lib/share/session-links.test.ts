/** @jest-environment jsdom */

import { getDb } from "@/lib/db/schema"
import { markSharedLinkRevoked, recordSharedLink, type SharedLinkRow } from "@/lib/db/shared-links"
import { createDbTestFixture } from "@/lib/db/test-fixture"

jest.mock("@/lib/share/client", () => ({ revokeShareLink: jest.fn() }))

import { listLiveShareLinksForSessions, revokeShareLinksForSessions } from "./session-links"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().sharedLinks.clear()
})
afterAll(dbFixture.dispose)

function link(code: string, partial: Partial<SharedLinkRow> = {}) {
  return recordSharedLink({
    code,
    kind: "file-bundle",
    url: `https://share.example/share/view?c=${code}`,
    createdAt: Date.now(),
    burnAfterRead: false,
    hasPassphrase: false,
    ...partial,
  })
}

describe("listLiveShareLinksForSessions", () => {
  it("lists only working links made from the given conversations", async () => {
    await link("A", { sessionId: "s1" })
    await link("B", { sessionId: "s2" })
    await link("C", { sessionId: "s3" })
    await link("D", { sessionId: "s1", expiresAt: 1_000 })
    await link("E", { sessionId: "s1" })
    await markSharedLinkRevoked("E")
    await link("F")

    const codes = (await listLiveShareLinksForSessions(["s1", "s2"], 2_000)).map((row) => row.code)
    expect(codes.sort()).toEqual(["A", "B"])
    expect(await listLiveShareLinksForSessions([])).toEqual([])
  })
})

describe("revokeShareLinksForSessions", () => {
  it("revokes each link on its own and counts the ones that failed", async () => {
    await link("A", { sessionId: "s1" })
    await link("B", { sessionId: "s1" })
    await link("C", { sessionId: "s2" })
    const revoke = jest.fn(async (code: string) => {
      if (code === "B") throw new Error("offline")
    })
    expect(await revokeShareLinksForSessions(["s1"], revoke)).toEqual({ revoked: 1, failed: 1 })
    expect(revoke.mock.calls.map(([code]) => code).sort()).toEqual(["A", "B"])
  })

  it("has nothing to do for a conversation that was never shared", async () => {
    const revoke = jest.fn(async () => {})
    expect(await revokeShareLinksForSessions(["s9"], revoke)).toEqual({ revoked: 0, failed: 0 })
    expect(revoke).not.toHaveBeenCalled()
  })
})
