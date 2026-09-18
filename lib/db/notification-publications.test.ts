/**
 * Tests for lib/db/notification-publications.ts — the serialized external
 * message slot. Covers get-or-create on the unique slotKey, the rendered
 * CAS on commit, and the open-for-fact listing.
 */

import { createDbTestFixture } from "./test-fixture"
import {
  getOrCreatePublication,
  commitPublicationRender,
  getPublication,
  getPublicationBySlot,
  listPublicationsForNotification,
} from "./notification-publications"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const SCOPE = "scope-A"

function input(over: Partial<Parameters<typeof getOrCreatePublication>[0]> = {}) {
  return {
    scopeKey: SCOPE,
    notificationId: over.notificationId ?? "n1",
    targetId: over.targetId ?? "t1",
    slotKey: over.slotKey ?? "run:purpose:fp",
    purpose: over.purpose ?? "terminal-state",
    runTerminal: over.runTerminal ?? false,
    state: over.state ?? "open",
    ...(over.logicalKey ? { logicalKey: over.logicalKey } : {}),
  }
}

describe("getOrCreatePublication", () => {
  it("creates a publication at renderedRevision 0", async () => {
    const row = await getOrCreatePublication(input())
    expect(row.renderedRevision).toBe(0)
    expect(row.state).toBe("open")
    expect(row.slotKey).toBe("run:purpose:fp")
  })

  it("returns the existing row for the same slotKey (no duplicate)", async () => {
    const a = await getOrCreatePublication(input({ slotKey: "s1" }))
    const b = await getOrCreatePublication(input({ slotKey: "s1", targetId: "different" }))
    expect(b.id).toBe(a.id)
    expect(b.targetId).toBe("t1") // the FIRST row wins
  })
})

describe("commitPublicationRender", () => {
  it("advances renderedRevision on a matching CAS", async () => {
    const pub = await getOrCreatePublication(input())
    const next = await commitPublicationRender(pub.id, 0, {
      platformMessageId: "m1",
      acceptedContentHash: "h",
    })
    expect(next?.renderedRevision).toBe(1)
    expect(next?.platformMessageId).toBe("m1")
    expect(next?.acceptedContentHash).toBe("h")
  })

  it("refuses a stale expectedRevision (a newer render already won)", async () => {
    const pub = await getOrCreatePublication(input())
    await commitPublicationRender(pub.id, 0, { platformMessageId: "m1" })
    const stale = await commitPublicationRender(pub.id, 0, { platformMessageId: "m2" })
    expect(stale).toBeUndefined()
    const stored = await getPublication(pub.id)
    expect(stored?.platformMessageId).toBe("m1")
    expect(stored?.renderedRevision).toBe(1)
  })
})

describe("getPublicationBySlot + listPublicationsForNotification", () => {
  it("finds the publication by its slot key", async () => {
    const pub = await getOrCreatePublication(input({ slotKey: "slot-x" }))
    const found = await getPublicationBySlot("slot-x")
    expect(found?.id).toBe(pub.id)
  })

  it("lists only OPEN publications for a fact", async () => {
    const open = await getOrCreatePublication(input({ notificationId: "n9", slotKey: "a" }))
    const closed = await getOrCreatePublication(input({ notificationId: "n9", slotKey: "b" }))
    const { getDb } = await import("./schema")
    await getDb().notificationPublications.put({ ...closed, state: "closed" })
    const rows = await listPublicationsForNotification("n9")
    expect(rows.map((p) => p.id)).toEqual([open.id])
  })
})
