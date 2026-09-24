import { act, renderHook } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"

import { useConversationDayClock, useConversationListModel } from "./use-conversation-list-model"

const NOW = new Date(2026, 5, 25, 12, 0, 0).getTime()

function session(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return { id, title: id, createdAt: NOW, updatedAt: NOW, ...overrides }
}

describe("useConversationListModel", () => {
  it("derives sections from sessions", () => {
    const sessions = [session("a", { pinned: true }), session("b")]
    const { result } = renderHook(() => useConversationListModel({ sessions, query: "", now: NOW }))
    expect(result.current.orderedIds).toEqual(["a", "b"])
    expect(result.current.sections[0]).toMatchObject({ kind: "pinned" })
  })

  it("memoizes the result while inputs are unchanged", () => {
    const sessions = [session("a")]
    const { result, rerender } = renderHook(
      (props: { q: string }) => useConversationListModel({ sessions, query: props.q, now: NOW }),
      { initialProps: { q: "" } }
    )
    const first = result.current
    rerender({ q: "" })
    expect(result.current).toBe(first)
  })

  it("re-derives when the query changes", () => {
    const sessions = [session("a", { title: "hello" })]
    const { result, rerender } = renderHook(
      (props: { q: string }) => useConversationListModel({ sessions, query: props.q, now: NOW }),
      { initialProps: { q: "" } }
    )
    const first = result.current
    rerender({ q: "zzz" })
    expect(result.current).not.toBe(first)
    expect(result.current.filteredCount).toBe(0)
  })

  it("defaults folders, view, and collapsedFolderIds", () => {
    const { result } = renderHook(() =>
      useConversationListModel({ sessions: [session("a")], query: "", now: NOW })
    )
    expect(result.current.total).toBe(1)
    expect(result.current.sections.some((s) => s.kind === "date")).toBe(true)
  })

  it("falls back to Date.now() when no clock is injected", () => {
    const { result } = renderHook(() =>
      useConversationListModel({ sessions: [session("a")], query: "" })
    )
    expect(result.current.orderedIds).toEqual(["a"])
  })

  // The default scorer is the whole point of the injection seam — every test
  // that passes its own would leave the production path unexercised.
  describe("default title ranker (shared with ⌘K)", () => {
    it("finds a fuzzy subsequence the substring rank would reject", () => {
      const { result } = renderHook(() =>
        useConversationListModel({ sessions: [session("deploy")], query: "dply", now: NOW })
      )
      expect(result.current.orderedIds).toEqual(["deploy"])
    })

    it("still ranks a prefix hit above a mid-word one", () => {
      const sessions = [
        session("reindex", { title: "reindex" }),
        session("index", { title: "index" }),
      ]
      const { result } = renderHook(() =>
        useConversationListModel({ sessions, query: "index", now: NOW })
      )
      expect(result.current.orderedIds).toEqual(["index", "reindex"])
    })

    it("drops a title that shares no subsequence with the query", () => {
      const { result } = renderHook(() =>
        useConversationListModel({ sessions: [session("alpha")], query: "zzzz", now: NOW })
      )
      expect(result.current.orderedIds).toEqual([])
    })

    it("can be turned off with scoreTitle: null", () => {
      const { result } = renderHook(() =>
        useConversationListModel({
          sessions: [session("deploy")],
          query: "dply",
          now: NOW,
          scoreTitle: null,
        })
      )
      expect(result.current.orderedIds).toEqual([])
    })
  })

  it("passes emitEmptyGroups through to the team axis", () => {
    // The merged rail's scope tree leans on this: every squad is a header even
    // when it has nothing to show.
    const teams = [
      { id: "t1", name: "Alpha" },
      { id: "t2", name: "Beta" },
    ]
    const { result } = renderHook(() =>
      useConversationListModel({
        sessions: [session("a", { kind: "team", teamId: "t1" })],
        query: "",
        now: NOW,
        groupBy: "team",
        teams,
        emitEmptyGroups: true,
      })
    )
    const keys = result.current.sections
      .filter((s) => s.kind === "group")
      .map((s) => (s.kind === "group" ? s.group.id : ""))
    expect(keys).toEqual(["__ungrouped__", "t1", "t2"])
  })
})

describe("useConversationListModel time zone", () => {
  it("buckets in the zone it is given", () => {
    const now = Date.UTC(2026, 7, 15, 6, 30)
    const sessions = [session("late", { updatedAt: Date.UTC(2026, 7, 14, 17, 0) })]
    const bucketIn = (timeZone: string) =>
      renderHook(() =>
        useConversationListModel({ sessions, query: "", now, timeZone, groupBy: "date" })
      ).result.current.sections.map((section) => section.kind === "date" && section.bucket)
    expect(bucketIn("Asia/Shanghai")).toEqual(["today"])
    expect(bucketIn("UTC")).toEqual(["yesterday"])
  })
})

describe("useConversationDayClock", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it("holds one value through the day and moves exactly when the day turns", () => {
    jest.useFakeTimers()
    // 23:59:00 UTC — one minute before midnight in the zone asked for.
    jest.setSystemTime(Date.UTC(2026, 7, 14, 23, 59, 0))
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useConversationDayClock("UTC")
    })
    const start = result.current
    const rendersAtMount = renders
    // The mount check and 30 seconds of ordinary time: same day, no render.
    act(() => {
      jest.advanceTimersByTime(30_000)
    })
    expect(result.current).toBe(start)
    expect(renders).toBe(rendersAtMount)
    // Past midnight: the clock moves once, to a moment in the new day.
    act(() => {
      jest.advanceTimersByTime(31_000)
    })
    expect(result.current).toBeGreaterThanOrEqual(Date.UTC(2026, 7, 15, 0, 0, 0))
    expect(renders).toBe(rendersAtMount + 1)
  })

  it("catches up on the day when the window wakes, without waiting for the timer", () => {
    jest.useFakeTimers()
    jest.setSystemTime(Date.UTC(2026, 7, 14, 12, 0, 0))
    const { result } = renderHook(() => useConversationDayClock("UTC"))
    act(() => {
      jest.advanceTimersByTime(0)
    })
    const before = result.current
    // A laptop lid opened the next morning: the clock jumped, no timer fired.
    jest.setSystemTime(Date.UTC(2026, 7, 15, 8, 0, 0))
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    expect(result.current).not.toBe(before)
    expect(result.current).toBe(Date.UTC(2026, 7, 15, 8, 0, 0))
  })

  it("stops its timer and listeners on unmount", () => {
    jest.useFakeTimers()
    const removeWindow = jest.spyOn(window, "removeEventListener")
    const removeDocument = jest.spyOn(document, "removeEventListener")
    const { unmount } = renderHook(() => useConversationDayClock("UTC"))
    unmount()
    expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function))
    expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function))
    expect(jest.getTimerCount()).toBe(0)
    removeWindow.mockRestore()
    removeDocument.mockRestore()
  })
})
