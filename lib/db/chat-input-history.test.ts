/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  recordInput,
  listInputHistory,
  listRecentInputHistory,
  clearInputHistory,
  MAX_HISTORY_PER_SESSION,
} from "./chat-input-history"
import { getDb } from "./schema"

beforeEach(async () => {
  await getDb().chatInputHistory.clear()
})

describe("chat-input-history", () => {
  it("records and lists newest-first", async () => {
    await recordInput("s1", "first")
    await recordInput("s1", "second")
    await recordInput("s1", "third")
    expect(await listInputHistory("s1")).toEqual(["third", "second", "first"])
  })

  it("ignores empty / whitespace text", async () => {
    await recordInput("s1", "")
    await recordInput("s1", "   ")
    expect(await listInputHistory("s1")).toEqual([])
  })

  it("trims surrounding whitespace before storing", async () => {
    await recordInput("s1", "  hello  ")
    expect(await listInputHistory("s1")).toEqual(["hello"])
  })

  it("dedupes a consecutive duplicate send", async () => {
    await recordInput("s1", "same")
    await recordInput("s1", "same")
    await recordInput("s1", "other")
    await recordInput("s1", "same")
    expect(await listInputHistory("s1")).toEqual(["same", "other", "same"])
  })

  it("dedupes a duplicate sent twice at once", async () => {
    await Promise.all([recordInput("s1", "same"), recordInput("s1", "same")])
    expect(await listInputHistory("s1")).toEqual(["same"])
  })

  it("keeps history isolated per session", async () => {
    await recordInput("s1", "a")
    await recordInput("s2", "b")
    expect(await listInputHistory("s1")).toEqual(["a"])
    expect(await listInputHistory("s2")).toEqual(["b"])
  })

  it("caps each session to MAX_HISTORY_PER_SESSION newest entries", async () => {
    for (let i = 0; i < MAX_HISTORY_PER_SESSION + 5; i++) {
      await recordInput("s1", `m${i}`)
    }
    const list = await listInputHistory("s1")
    expect(list).toHaveLength(MAX_HISTORY_PER_SESSION)
    expect(list[0]).toBe(`m${MAX_HISTORY_PER_SESSION + 4}`) // newest retained
    expect(list).not.toContain("m0") // oldest trimmed
  })

  it("clears a session's history", async () => {
    await recordInput("s1", "x")
    await clearInputHistory("s1")
    expect(await listInputHistory("s1")).toEqual([])
  })

  it("returns empty for a blank session id", async () => {
    expect(await listInputHistory("")).toEqual([])
  })

  it("lists recent lines across conversations, optionally without one of them", async () => {
    await recordInput("s1", "a")
    await new Promise((resolve) => setTimeout(resolve, 2))
    await recordInput("s2", "b")
    await new Promise((resolve) => setTimeout(resolve, 2))
    await recordInput("s1", "c")
    expect(await listRecentInputHistory()).toEqual(["c", "b", "a"])
    expect(await listRecentInputHistory(undefined, { excludeSessionId: "s1" })).toEqual(["b"])
  })
})
