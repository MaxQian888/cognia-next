/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import {
  __resetEntityMentionSourcesForTests,
  registerEntityMentionSource,
  unregisterEntityMentionSource,
  type EntityMentionCandidate,
} from "@/lib/chat/mentions/entity-sources"
import type { EntitySelectionKind } from "@/types/artifact/artifact"
import { ENTITY_SEARCH_DEBOUNCE_MS, useEntityMentionSearch } from "./use-entity-mention-search"

const CUSTOM = "custom" as EntitySelectionKind

function candidate(id: string): EntityMentionCandidate {
  return { entityKind: CUSTOM, id, title: id, searchText: id }
}

let search: jest.Mock

beforeEach(() => {
  jest.useFakeTimers()
  __resetEntityMentionSourcesForTests()
  search = jest.fn(async () => [candidate("a")])
  registerEntityMentionSource({
    entityKind: CUSTOM,
    prefix: "custom:",
    search: (q, ctx) => search(q, ctx),
    snapshot: async () => "body",
  })
})

afterEach(() => {
  jest.useRealTimers()
  unregisterEntityMentionSource(CUSTOM)
})

async function flushDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(ENTITY_SEARCH_DEBOUNCE_MS)
  })
}

describe("useEntityMentionSearch", () => {
  it("is inert with no namespace — the panel is closed", () => {
    const { result } = renderHook(() =>
      useEntityMentionSearch({ namespace: null, query: "", context: {} })
    )
    expect(result.current.source).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(search).not.toHaveBeenCalled()
  })

  it("resolves the source from the prefix and returns its rows", async () => {
    const { result } = renderHook(() =>
      useEntityMentionSearch({ namespace: "custom:", query: "a", context: {} })
    )
    await flushDebounce()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.source?.entityKind).toBe(CUSTOM)
    expect(result.current.items).toEqual([candidate("a")])
  })

  it("debounces rather than scanning on every keystroke", async () => {
    const { rerender } = renderHook(
      ({ query }) => useEntityMentionSearch({ namespace: "custom:", query, context: {} }),
      { initialProps: { query: "a" } }
    )
    rerender({ query: "ab" })
    rerender({ query: "abc" })
    expect(search).not.toHaveBeenCalled()
    await flushDebounce()
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith("abc", { projectId: null, sessionId: null })
  })

  it("trims the query before handing it to the source", async () => {
    renderHook(() => useEntityMentionSearch({ namespace: "custom:", query: "  x ", context: {} }))
    await flushDebounce()
    expect(search).toHaveBeenCalledWith("x", expect.anything())
  })

  it("passes the workspace and conversation scope through", async () => {
    renderHook(() =>
      useEntityMentionSearch({
        namespace: "custom:",
        query: "",
        context: { projectId: "p1", sessionId: "s1" },
      })
    )
    await flushDebounce()
    expect(search).toHaveBeenCalledWith("", { projectId: "p1", sessionId: "s1" })
  })

  it("does not re-run when only the identity of the context object changes", async () => {
    // `context` is a fresh object every render; keying on it would re-scan on
    // every keystroke of the SURROUNDING message.
    const { rerender } = renderHook(
      ({ ctx }) => useEntityMentionSearch({ namespace: "custom:", query: "a", context: ctx }),
      { initialProps: { ctx: { projectId: "p1", sessionId: "s1" } } }
    )
    await flushDebounce()
    expect(search).toHaveBeenCalledTimes(1)
    rerender({ ctx: { projectId: "p1", sessionId: "s1" } })
    await flushDebounce()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it("surfaces a failed read as an error, not as an empty list", async () => {
    // "No matches" when the table could not be opened is exactly the lie the
    // dormancy rule exists to prevent.
    search.mockRejectedValueOnce(new Error("db closed"))
    const { result } = renderHook(() =>
      useEntityMentionSearch({ namespace: "custom:", query: "a", context: {} })
    )
    await flushDebounce()
    await waitFor(() => expect(result.current.error).toBe("db closed"))
    expect(result.current.items).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it("clears a previous error once a later query succeeds", async () => {
    search.mockRejectedValueOnce(new Error("db closed"))
    const { result, rerender } = renderHook(
      ({ query }) => useEntityMentionSearch({ namespace: "custom:", query, context: {} }),
      { initialProps: { query: "a" } }
    )
    await flushDebounce()
    await waitFor(() => expect(result.current.error).toBe("db closed"))
    rerender({ query: "b" })
    await flushDebounce()
    await waitFor(() => expect(result.current.error).toBeNull())
  })

  it("reports no source for an unregistered prefix", () => {
    const { result } = renderHook(() =>
      useEntityMentionSearch({ namespace: "nope:", query: "a", context: {} })
    )
    expect(result.current.source).toBeNull()
    expect(search).not.toHaveBeenCalled()
  })
})
