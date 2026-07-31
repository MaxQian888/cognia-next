/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

const searchChatHistory = jest.fn()
const drainSearchIndex = jest.fn()
const scheduleSearchIndexDrain = jest.fn()

jest.mock("@/lib/chat/search/engine", () => ({
  searchChatHistory: (...args: unknown[]) => searchChatHistory(...args),
}))

jest.mock("@/lib/chat/search/indexer", () => ({
  drainSearchIndex: (...args: unknown[]) => drainSearchIndex(...args),
  scheduleSearchIndexDrain: (...args: unknown[]) => scheduleSearchIndexDrain(...args),
}))

const chatState: {
  activeSessionId: string | null
  messages: UIMessage[]
  sessions: Record<string, { messages: UIMessage[] }>
} = {
  activeSessionId: null,
  messages: [],
  sessions: {},
}

jest.mock("@/stores/chat", () => ({
  useChatStore: {
    getState: () => chatState,
  },
}))

import { useChatHistorySearch } from "./use-chat-history-search"

const EMPTY_OUTCOME = {
  results: [],
  moreOlderHistory: false,
  indexIncomplete: false,
}

beforeEach(() => {
  searchChatHistory.mockReset().mockResolvedValue(EMPTY_OUTCOME)
  drainSearchIndex.mockReset().mockResolvedValue(undefined)
  scheduleSearchIndexDrain.mockReset()
  chatState.activeSessionId = null
  chatState.messages = []
  chatState.sessions = {}
})

test("starts the idle indexer on mount without searching a short query", async () => {
  renderHook(() => useChatHistorySearch("a"))

  expect(scheduleSearchIndexDrain).toHaveBeenCalledTimes(1)
  expect(searchChatHistory).not.toHaveBeenCalled()
})

test("does not search while its owning surface is disabled", () => {
  renderHook(() => useChatHistorySearch("long enough", { enabled: false }))

  expect(searchChatHistory).not.toHaveBeenCalled()
})

test("drains pending writes before running an indexed search", async () => {
  const outcome = {
    ...EMPTY_OUTCOME,
    results: [{ messageId: "m1", sessionId: "s1" }],
  }
  searchChatHistory.mockResolvedValue(outcome)

  const { result } = renderHook(() =>
    useChatHistorySearch("needle", {
      projectId: "project-1",
      includeArchived: true,
      collapseBySession: true,
      limit: 24,
    })
  )

  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(drainSearchIndex).toHaveBeenCalledTimes(1)
  expect(searchChatHistory).toHaveBeenCalledWith(
    {
      query: "needle",
      projectId: "project-1",
      includeArchived: true,
      collapseBySession: true,
      limit: 24,
    },
    expect.objectContaining({ pendingRows: expect.any(Function) })
  )
  expect(result.current.results).toBe(outcome.results)
})

test("ignores a slower stale response after the query changes", async () => {
  let resolveFirst: ((value: typeof EMPTY_OUTCOME) => void) | undefined
  searchChatHistory
    .mockImplementationOnce(
      () =>
        new Promise<typeof EMPTY_OUTCOME>((resolve) => {
          resolveFirst = resolve
        })
    )
    .mockResolvedValueOnce({
      ...EMPTY_OUTCOME,
      results: [{ messageId: "new", sessionId: "s2" }],
    })

  const { result, rerender } = renderHook(({ query }) => useChatHistorySearch(query), {
    initialProps: { query: "first" },
  })
  rerender({ query: "second" })

  await waitFor(() => expect(result.current.results[0]?.messageId).toBe("new"))
  act(() => resolveFirst?.(EMPTY_OUTCOME))
  expect(result.current.results[0]?.messageId).toBe("new")
})

test("projects open in-memory messages so the latest streaming text is searchable", async () => {
  chatState.activeSessionId = "s1"
  chatState.messages = [
    {
      id: "m-live",
      role: "assistant",
      parts: [{ type: "text", text: "fresh streaming answer" }],
      metadata: { createdAt: 123 },
    } as UIMessage,
  ]

  renderHook(() => useChatHistorySearch("streaming"))
  await waitFor(() => expect(searchChatHistory).toHaveBeenCalled())

  const overrides = searchChatHistory.mock.calls[0][1] as {
    pendingRows: () => Array<Record<string, unknown>>
  }
  expect(overrides.pendingRows()).toEqual([
    expect.objectContaining({
      messageId: "m-live",
      sessionId: "s1",
      role: "assistant",
      createdAt: 123,
      text: "fresh streaming answer",
    }),
  ])
})

test("deduplicates open slices and skips messages without searchable text", async () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(999)
  chatState.activeSessionId = "s2"
  chatState.sessions = {
    s1: {
      messages: [
        {
          id: "shared",
          role: "user",
          parts: [{ type: "text", text: "first copy" }],
          metadata: { createdAt: "invalid" },
        } as UIMessage,
        { id: "", role: "user", parts: [{ type: "text", text: "missing id" }] } as UIMessage,
        { id: "empty", role: "assistant", parts: [] } as unknown as UIMessage,
      ],
    },
  }
  chatState.messages = [
    {
      id: "shared",
      role: "user",
      parts: [{ type: "text", text: "duplicate copy" }],
    } as UIMessage,
    {
      id: "active",
      role: "assistant",
      parts: [{ type: "text", text: "active copy" }],
      metadata: { createdAt: 321 },
    } as UIMessage,
  ]

  renderHook(() => useChatHistorySearch("copy"))
  await waitFor(() => expect(searchChatHistory).toHaveBeenCalled())

  const overrides = searchChatHistory.mock.calls[0][1] as {
    pendingRows: () => Array<Record<string, unknown>>
  }
  expect(overrides.pendingRows()).toEqual([
    expect.objectContaining({ messageId: "shared", sessionId: "s1", createdAt: 999 }),
    expect.objectContaining({ messageId: "active", sessionId: "s2", createdAt: 321 }),
  ])
  now.mockRestore()
})

test.each([new Error("offline"), "offline"])(
  "surfaces search failures without leaving stale results",
  async (failure) => {
    searchChatHistory.mockRejectedValue(failure)

    const { result } = renderHook(() => useChatHistorySearch("needle"))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.results).toEqual([])
    expect(result.current.error).toEqual(expect.objectContaining({ message: "offline" }))
  }
)
