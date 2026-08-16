/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

import { makeTestContext } from "@/lib/global-search/testing"
import type { GlobalSearchGroup, GlobalSearchOutcome } from "@/lib/global-search/types"

const runGlobalSearch = jest.fn()
const runGlobalSearchSuggestions = jest.fn()
const registerBuiltin = jest.fn()
const drainSearchIndex = jest.fn()
const scheduleSearchIndexDrain = jest.fn()

jest.mock("@/lib/global-search/engine", () => ({
  runGlobalSearch: (...args: unknown[]) => runGlobalSearch(...args),
  runGlobalSearchSuggestions: (...args: unknown[]) => runGlobalSearchSuggestions(...args),
}))
jest.mock("@/lib/global-search/providers", () => ({
  registerBuiltinGlobalSearchProviders: (...args: unknown[]) => registerBuiltin(...args),
}))
jest.mock("@/lib/chat/search/indexer", () => ({
  drainSearchIndex: (...args: unknown[]) => drainSearchIndex(...args),
  scheduleSearchIndexDrain: (...args: unknown[]) => scheduleSearchIndexDrain(...args),
}))

const chatState: {
  activeSessionId: string | null
  messages: UIMessage[]
  sessions: Record<string, { messages: UIMessage[] }>
} = { activeSessionId: null, messages: [], sessions: {} }
jest.mock("@/stores/chat", () => ({ useChatStore: { getState: () => chatState } }))

import { GLOBAL_SEARCH_DEBOUNCE_MS, pendingChatRows, useGlobalSearch } from "./use-global-search"

const outcome = (over: Partial<GlobalSearchOutcome> = {}): GlobalSearchOutcome => ({
  groups: [],
  totalHits: 0,
  coverage: "complete",
  tookMs: 1,
  aborted: false,
  ...over,
})

const group: GlobalSearchGroup = {
  kind: "action",
  providerId: "p",
  items: [],
  bestScore: 1,
  total: 1,
  truncated: false,
  coverage: "complete",
}

beforeEach(() => {
  jest.useFakeTimers()
  runGlobalSearch.mockReset().mockResolvedValue(outcome())
  runGlobalSearchSuggestions.mockReset().mockResolvedValue([group])
  registerBuiltin.mockReset()
  drainSearchIndex.mockReset().mockResolvedValue(undefined)
  scheduleSearchIndexDrain.mockReset()
  chatState.activeSessionId = null
  chatState.messages = []
  chatState.sessions = {}
})

afterEach(() => {
  jest.useRealTimers()
})

const ctx = makeTestContext()

describe("useGlobalSearch", () => {
  it("registers built-ins with pending rows, schedules the drain, and loads suggestions for the empty query", async () => {
    const { result } = renderHook(() => useGlobalSearch({ rawQuery: "", ctx, enabled: true }))
    expect(registerBuiltin).toHaveBeenCalledWith({
      messages: { pendingRows: pendingChatRows },
    })
    expect(scheduleSearchIndexDrain).toHaveBeenCalledTimes(1)
    await act(async () => {
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.suggestions).toEqual([group]))
    expect(runGlobalSearch).not.toHaveBeenCalled()
    expect(result.current.outcome).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it("does nothing while disabled", () => {
    renderHook(() => useGlobalSearch({ rawQuery: "hello", ctx, enabled: false }))
    act(() => {
      jest.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS + 10)
    })
    expect(runGlobalSearch).not.toHaveBeenCalled()
    expect(runGlobalSearchSuggestions).not.toHaveBeenCalled()
  })

  it("debounces the query, drains the index, and publishes the outcome", async () => {
    const found = outcome({ groups: [group], totalHits: 1 })
    runGlobalSearch.mockResolvedValue(found)
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useGlobalSearch({ rawQuery: q, ctx, enabled: true, limit: 9 }),
      { initialProps: { q: "" } }
    )
    rerender({ q: "he" })
    rerender({ q: "hello" })
    expect(runGlobalSearch).not.toHaveBeenCalled()
    await act(async () => {
      jest.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS + 1)
    })
    await waitFor(() => expect(runGlobalSearch).toHaveBeenCalledTimes(1))
    expect(drainSearchIndex).toHaveBeenCalled()
    const [parsed, passedCtx, options] = runGlobalSearch.mock.calls[0]!
    expect(parsed.text).toBe("hello")
    expect(passedCtx).toBe(ctx)
    expect(options.limit).toBe(9)
    expect(options.signal).toBeInstanceOf(AbortSignal)
    await waitFor(() => expect(result.current.outcome).toEqual(found))
    expect(result.current.loading).toBe(false)
    expect(result.current.parsed.text).toBe("hello")
  })

  it("aborts the superseded run and ignores its late result", async () => {
    let resolveFirst!: (o: GlobalSearchOutcome) => void
    const first = new Promise<GlobalSearchOutcome>((resolve) => {
      resolveFirst = resolve
    })
    runGlobalSearch.mockImplementationOnce(() => first)
    const second = outcome({ totalHits: 2 })
    runGlobalSearch.mockImplementationOnce(async () => second)
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useGlobalSearch({ rawQuery: q, ctx, enabled: true }),
      { initialProps: { q: "one" } }
    )
    await act(async () => {
      jest.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS + 1)
    })
    await waitFor(() => expect(runGlobalSearch).toHaveBeenCalledTimes(1))
    const firstSignal: AbortSignal = runGlobalSearch.mock.calls[0]![2].signal
    rerender({ q: "two" })
    await act(async () => {
      jest.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS + 1)
    })
    await waitFor(() => expect(runGlobalSearch).toHaveBeenCalledTimes(2))
    expect(firstSignal.aborted).toBe(true)
    await waitFor(() => expect(result.current.outcome?.totalHits).toBe(2))
    await act(async () => {
      resolveFirst(outcome({ totalHits: 1 }))
    })
    expect(result.current.outcome?.totalHits).toBe(2)
  })

  it("drops an outcome the engine flagged as aborted", async () => {
    runGlobalSearch.mockResolvedValue(outcome({ aborted: true, totalHits: 5 }))
    const { result } = renderHook(() => useGlobalSearch({ rawQuery: "x y", ctx, enabled: true }))
    await act(async () => {
      jest.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS + 1)
    })
    await waitFor(() => expect(runGlobalSearch).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.outcome).toBeNull()
  })

  it("surfaces engine errors and recovers on refresh", async () => {
    runGlobalSearch.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(outcome())
    const { result } = renderHook(() => useGlobalSearch({ rawQuery: "bad", ctx, enabled: true }))
    await act(async () => {
      jest.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS + 1)
    })
    await waitFor(() => expect(result.current.error?.message).toBe("boom"))
    expect(result.current.loading).toBe(false)
    act(() => result.current.refresh())
    await waitFor(() => expect(runGlobalSearch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.error).toBeNull())
    // Non-Error rejections are wrapped.
    runGlobalSearch.mockRejectedValueOnce("raw")
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.error?.message).toBe("raw"))
  })

  it("survives a failing suggestion run and a failing drain", async () => {
    runGlobalSearchSuggestions.mockRejectedValue(new Error("nope"))
    drainSearchIndex.mockRejectedValue(new Error("drain"))
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useGlobalSearch({ rawQuery: q, ctx, enabled: true }),
      { initialProps: { q: "" } }
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.suggestions).toEqual([])
    rerender({ q: "hi" })
    await act(async () => {
      jest.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS + 1)
    })
    await waitFor(() => expect(runGlobalSearch).toHaveBeenCalled())
  })
})

describe("pendingChatRows", () => {
  it("projects open slices and the active session, deduping ids", () => {
    const message = (id: string, text: string, createdAt?: number): UIMessage =>
      ({
        id,
        role: "user",
        parts: [{ type: "text", text }],
        metadata: createdAt ? { createdAt } : undefined,
      }) as unknown as UIMessage
    chatState.sessions = {
      s1: { messages: [message("m1", "hello", 5), message("m2", "")] },
    }
    chatState.activeSessionId = "s2"
    chatState.messages = [message("m1", "dup"), message("m3", "world")]
    const rows = pendingChatRows()
    expect(rows.map((r) => r.messageId)).toEqual(["m1", "m3"])
    expect(rows[0]).toMatchObject({ sessionId: "s1", text: "hello", createdAt: 5, projectId: "" })
    expect(typeof rows[1]!.createdAt).toBe("number")
    // Messages without ids are skipped.
    chatState.messages = [{ role: "user", parts: [] } as unknown as UIMessage]
    chatState.sessions = {}
    expect(pendingChatRows()).toEqual([])
  })
})
