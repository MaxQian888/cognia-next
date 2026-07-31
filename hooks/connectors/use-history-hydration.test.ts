/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"

const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))

const mockListAdapters = jest.fn()
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({ listAdapters: () => mockListAdapters() }),
}))

const mockFindSession = jest.fn()
const mockInsert = jest.fn()
jest.mock("@/lib/connectors/runtime", () => ({
  findSessionByConversationKey: (...args: unknown[]) => mockFindSession(...args),
  insertInboundMessage: (...args: unknown[]) => mockInsert(...args),
}))

const mockToArray = jest.fn()
const mockGetConversationState = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    messages: { where: () => ({ equals: () => ({ toArray: () => mockToArray() }) }) },
    connectorConversationStates: { get: (...args: unknown[]) => mockGetConversationState(...args) },
  }),
}))

import { HISTORY_PAGE_MAX, useHistoryHydration } from "./use-history-hydration"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function* gen(events: any[]) {
  for (const e of events) yield e
}

function makeEvent(messageId: string, timestamp: number) {
  return {
    messageId,
    timestamp,
    kind: "create",
    conversationKey: "k",
    segments: [],
    plainText: messageId,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsTauri.mockReturnValue(true)
  mockFindSession.mockResolvedValue({ id: "sess-1" })
  mockToArray.mockResolvedValue([])
  mockGetConversationState.mockResolvedValue(undefined)
  mockInsert.mockResolvedValue(undefined)
})

describe("useHistoryHydration", () => {
  it("uses the persisted target and typed timestamp cursor for page-based adapters", async () => {
    mockToArray.mockResolvedValue([{ platformMessageId: "m-old", createdAt: 100 }])
    const deliveryTarget = {
      address: {
        conversationKey: "k",
        platform: "lark",
        adapterId: "adp",
        scopeKind: "thread",
        containerId: "oc-1",
        topicId: "omt-1",
      },
      conversationRef: { platform: "lark", adapterId: "adp", channelId: "oc-1" },
      refreshedAt: 100,
    }
    mockGetConversationState.mockResolvedValue({ deliveryTarget })
    const fetchHistoryPage = jest
      .fn()
      .mockResolvedValueOnce({
        events: [makeEvent("m-older", 50)],
        nextCursor: { kind: "timestamp", beforeTimestamp: 100, pageToken: "next" },
      })
      .mockResolvedValueOnce({ events: [] })
    mockListAdapters.mockReturnValue([{ id: "adp", fetchHistoryPage }])

    const { result } = renderHook(() => useHistoryHydration("k", "adp"))
    await act(async () => {
      await result.current.hydrate()
    })

    expect(fetchHistoryPage).toHaveBeenNthCalledWith(
      1,
      deliveryTarget,
      { kind: "timestamp", beforeTimestamp: 100 },
      { max: HISTORY_PAGE_MAX }
    )
    expect(fetchHistoryPage).toHaveBeenNthCalledWith(
      2,
      deliveryTarget,
      { kind: "timestamp", beforeTimestamp: 100, pageToken: "next" },
      { max: HISTORY_PAGE_MAX - 1 }
    )
  })

  it("inserts new history events with their original timestamp", async () => {
    let captured: { before?: string; max?: number } | undefined
    mockListAdapters.mockReturnValue([
      {
        id: "adp",
        fetchHistory: (_key: string, opts: { before?: string; max?: number }) => {
          captured = opts
          return gen([makeEvent("m1", 1000), makeEvent("m2", 2000)])
        },
      },
    ])

    const { result } = renderHook(() => useHistoryHydration("k", "adp"))
    let count = 0
    await act(async () => {
      count = await result.current.hydrate()
    })

    expect(count).toBe(2)
    expect(mockInsert).toHaveBeenCalledTimes(2)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m1" }),
      "sess-1",
      1000
    )
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m2" }),
      "sess-1",
      2000
    )
    // No stored messages → no before cursor on the first load.
    expect(captured?.before).toBeUndefined()
    expect(result.current.lastCount).toBe(2)
  })

  it("uses the oldest timestamp for timestamp-cursor adapters and dedups", async () => {
    mockToArray.mockResolvedValue([
      { platformMessageId: "m-old", createdAt: 100 },
      { platformMessageId: "m-new", createdAt: 500 },
    ])
    let captured: { before?: string } | undefined
    mockListAdapters.mockReturnValue([
      {
        id: "adp",
        historyCursorKind: "timestamp",
        fetchHistory: (_key: string, opts: { before?: string }) => {
          captured = opts
          // m-old is already stored → skipped; m-older is new → inserted.
          return gen([makeEvent("m-old", 100), makeEvent("m-older", 50)])
        },
      },
    ])

    const { result } = renderHook(() => useHistoryHydration("k", "adp"))
    let count = 0
    await act(async () => {
      count = await result.current.hydrate()
    })

    expect(captured?.before).toBe("100")
    expect(count).toBe(1)
    expect(mockInsert).toHaveBeenCalledTimes(1)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m-older" }),
      "sess-1",
      50
    )
  })

  it("drops an adapter history event that belongs to another conversation scope", async () => {
    mockListAdapters.mockReturnValue([
      {
        id: "adp",
        fetchHistory: () => gen([{ ...makeEvent("wrong", 1), conversationKey: "another-topic" }]),
      },
    ])
    const { result } = renderHook(() => useHistoryHydration("k", "adp"))
    await act(async () => {
      await result.current.hydrate()
    })
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it("skips edit/delete/system events", async () => {
    mockListAdapters.mockReturnValue([
      {
        id: "adp",
        fetchHistory: () =>
          gen([{ messageId: "e1", timestamp: 1, kind: "edit" }, makeEvent("m1", 2)]),
      },
    ])
    const { result } = renderHook(() => useHistoryHydration("k", "adp"))
    let count = 0
    await act(async () => {
      count = await result.current.hydrate()
    })
    expect(count).toBe(1)
    expect(mockInsert).toHaveBeenCalledTimes(1)
  })

  it("is a no-op with an unsupported error in web mode", async () => {
    mockIsTauri.mockReturnValue(false)
    const { result } = renderHook(() => useHistoryHydration("k", "adp"))
    let count = 0
    await act(async () => {
      count = await result.current.hydrate()
    })
    expect(count).toBe(0)
    expect(result.current.canHydrate).toBe(false)
    expect(result.current.error).toBe("unsupported")
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it("reports unsupported when the adapter has no fetchHistory", async () => {
    mockListAdapters.mockReturnValue([{ id: "adp" }])
    const { result } = renderHook(() => useHistoryHydration("k", "adp"))
    await act(async () => {
      await result.current.hydrate()
    })
    expect(result.current.error).toBe("unsupported")
  })

  it("returns 0 when there is no session for the conversation", async () => {
    mockFindSession.mockResolvedValue(undefined)
    mockListAdapters.mockReturnValue([{ id: "adp", fetchHistory: () => gen([makeEvent("m1", 1)]) }])
    const { result } = renderHook(() => useHistoryHydration("k", "adp"))
    let count = 0
    await act(async () => {
      count = await result.current.hydrate()
    })
    expect(count).toBe(0)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it("surfaces a failed error when fetchHistory throws", async () => {
    mockListAdapters.mockReturnValue([
      {
        id: "adp",

        fetchHistory: async function* () {
          throw new Error("network")
        },
      },
    ])
    const { result } = renderHook(() => useHistoryHydration("k", "adp"))
    await act(async () => {
      await result.current.hydrate()
    })
    expect(result.current.error).toBe("failed")
  })
})
