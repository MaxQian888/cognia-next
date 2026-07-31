/** @jest-environment jsdom */
// Coverage for the per-session unread tracker (session-state.ts).

import "fake-indexeddb/auto"
import { bumpUnread, getSessionState, listSessionStates, markSessionRead } from "./session-state"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().sessionState.clear()
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
