/**
 * @jest-environment jsdom
 */
import {
  MAX_RECENT_ITEMS,
  MAX_RECENT_QUERIES,
  RECENT_ITEMS_KEY,
  RECENT_QUERIES_KEY,
  clearAllGlobalSearchRecents,
  clearRecentItems,
  clearRecentQueries,
  getGlobalSearchRecentsRevision,
  listRecentItems,
  listRecentQueries,
  recordRecentItem,
  recordRecentQuery,
  removeRecentItem,
  removeRecentQuery,
  subscribeGlobalSearchRecents,
  toStoredAction,
} from "./recents"
import type { GlobalSearchItem } from "./types"

const item = (id: string, over: Partial<GlobalSearchItem> = {}): GlobalSearchItem => ({
  id,
  kind: "session",
  title: `T ${id}`,
  score: 1,
  action: { type: "open-session", sessionId: id },
  ...over,
})

describe("global-search recents", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("records queries newest-first, dedupes, trims and caps", () => {
    recordRecentQuery("a")
    expect(listRecentQueries()).toEqual([])
    recordRecentQuery("  hello ")
    recordRecentQuery("world")
    recordRecentQuery("hello")
    expect(listRecentQueries()).toEqual(["hello", "world"])
    for (let i = 0; i < MAX_RECENT_QUERIES + 3; i++) recordRecentQuery(`q${i}`)
    expect(listRecentQueries()).toHaveLength(MAX_RECENT_QUERIES)
    expect(listRecentQueries()[0]).toBe(`q${MAX_RECENT_QUERIES + 2}`)
    removeRecentQuery(`q${MAX_RECENT_QUERIES + 2}`)
    expect(listRecentQueries()[0]).toBe(`q${MAX_RECENT_QUERIES + 1}`)
    clearRecentQueries()
    expect(listRecentQueries()).toEqual([])
  })

  it("records items, dedupes by id, caps, and skips callback actions", () => {
    recordRecentItem(item("1"), 10)
    recordRecentItem(item("2"), 20)
    recordRecentItem(item("1"), 30)
    expect(listRecentItems().map((r) => r.id)).toEqual(["1", "2"])
    expect(listRecentItems()[0]!.openedAt).toBe(30)
    recordRecentItem(item("cb", { action: { type: "callback", run: () => {} } }))
    expect(listRecentItems().map((r) => r.id)).toEqual(["1", "2"])
    for (let i = 0; i < MAX_RECENT_ITEMS + 2; i++) recordRecentItem(item(`x${i}`))
    expect(listRecentItems()).toHaveLength(MAX_RECENT_ITEMS)
    removeRecentItem(`x${MAX_RECENT_ITEMS + 1}`)
    expect(listRecentItems()).toHaveLength(MAX_RECENT_ITEMS - 1)
    clearRecentItems()
    expect(listRecentItems()).toEqual([])
  })

  it("stores quick actions by id", () => {
    expect(
      toStoredAction({
        type: "quick-action",
        entry: { fullId: "p:a" } as never,
      })
    ).toEqual({ type: "quick-action-ref", fullId: "p:a" })
    expect(toStoredAction({ type: "callback", run: () => {} })).toBeNull()
    expect(toStoredAction({ type: "navigate", href: "/x" })).toEqual({
      type: "navigate",
      href: "/x",
    })
  })

  it("ignores malformed storage and notifies subscribers", () => {
    window.localStorage.setItem(RECENT_QUERIES_KEY, "{not json")
    window.localStorage.setItem(RECENT_ITEMS_KEY, JSON.stringify([{ nope: 1 }, "str", null]))
    expect(listRecentQueries()).toEqual([])
    expect(listRecentItems()).toEqual([])
    window.localStorage.setItem(RECENT_QUERIES_KEY, JSON.stringify({ a: 1 }))
    expect(listRecentQueries()).toEqual([])
    const listener = jest.fn()
    const off = subscribeGlobalSearchRecents(listener)
    const r0 = getGlobalSearchRecentsRevision()
    recordRecentQuery("hello")
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getGlobalSearchRecentsRevision()).toBe(r0 + 1)
    clearAllGlobalSearchRecents()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listRecentQueries()).toEqual([])
    off()
    recordRecentQuery("again")
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("survives a throwing localStorage", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied")
      },
    })
    try {
      expect(listRecentQueries()).toEqual([])
      expect(() => recordRecentQuery("hello")).not.toThrow()
    } finally {
      Object.defineProperty(window, "localStorage", original)
    }
  })

  it("swallows setItem quota errors", () => {
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    try {
      expect(() => recordRecentQuery("hello")).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})
