// Coverage for the per-session unread tracker (session-state.ts).

import { bumpUnread, getSessionState, listSessionStates, markSessionRead } from "./session-state"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import Dexie from "dexie"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().sessionState.clear()
  await getDb().sessions.bulkPut(
    ["s1", "s2"].map((id) => ({
      id,
      projectId: "p",
      kind: "direct" as const,
      title: id,
      createdAt: 1,
      updatedAt: 1,
    }))
  )
})
afterAll(dbFixture.dispose)

describe.each([
  { name: "markSessionRead", write: markSessionRead },
  { name: "bumpUnread", write: bumpUnread },
])("$name lifecycle", ({ write }) => {
  it("does not create state for a missing parent", async () => {
    await write("missing")
    expect(await getSessionState("missing")).toBeUndefined()
  })

  it("does not resurrect state after an overlapping session deletion", async () => {
    const db = getDb()
    await bumpUnread("s1")
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const deletion = db.transaction("rw", db.sessions, db.sessionState, async () => {
      await db.sessions.delete("s1")
      await db.sessionState.delete("s1")
      started()
      await Dexie.waitFor(gate)
    })
    await ready
    const update = Dexie.ignoreTransaction(() => write("s1"))
    release()
    await Promise.all([deletion, update])
    expect(await Dexie.ignoreTransaction(() => getSessionState("s1"))).toBeUndefined()
  })
})

describe("markSessionRead", () => {
  it("creates a row with unreadCount=0 and a fresh lastReadAt", async () => {
    const before = Date.now()
    await markSessionRead("s1")
    const row = await getSessionState("s1")
    expect(row?.unreadCount).toBe(0)
    expect(row?.lastReadAt).toBeGreaterThanOrEqual(before)
  })

  it("overwrites prior unread count for the same session", async () => {
    await bumpUnread("s1")
    await bumpUnread("s1")
    await markSessionRead("s1")
    const row = await getSessionState("s1")
    expect(row?.unreadCount).toBe(0)
  })
})

describe("bumpUnread", () => {
  it("creates a row at count=1 the first time", async () => {
    await bumpUnread("s1")
    const row = await getSessionState("s1")
    expect(row?.unreadCount).toBe(1)
    // No prior read pointer, so lastReadAt defaults to 0.
    expect(row?.lastReadAt).toBe(0)
  })

  it("increments the existing count without resetting lastReadAt", async () => {
    await markSessionRead("s1")
    const before = await getSessionState("s1")
    await bumpUnread("s1")
    await bumpUnread("s1")
    const after = await getSessionState("s1")
    expect(after?.unreadCount).toBe(2)
    expect(after?.lastReadAt).toBe(before?.lastReadAt)
  })
})

describe("getSessionState / listSessionStates", () => {
  it("returns undefined for unknown sessions", async () => {
    expect(await getSessionState("nope")).toBeUndefined()
  })

  it("listSessionStates returns every persisted row", async () => {
    await bumpUnread("s1")
    await bumpUnread("s2")
    const all = await listSessionStates()
    expect(all.length).toBe(2)
    expect(all.map((r) => r.sessionId).sort()).toEqual(["s1", "s2"])
  })
})
