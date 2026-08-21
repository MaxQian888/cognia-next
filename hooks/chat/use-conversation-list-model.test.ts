import { renderHook } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"

import { useConversationListModel } from "./use-conversation-list-model"

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
})
