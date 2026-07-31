/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import { useLearnedMemories, useRecalledMemories } from "./use-message-memories"
import { getMemory, listMemoriesBySourceMessageId } from "@/lib/db/memories"
import type { Memory } from "@/types/memory/memory"

// Capture the querier so each test can drive it directly; `liveResult` stands
// in for whatever Dexie would have resolved (undefined = still loading).
let lastQuerier: (() => unknown) | undefined
let liveResult: unknown
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => unknown) => {
    lastQuerier = querier
    return liveResult
  },
}))

jest.mock("@/lib/db/memories", () => ({
  getMemory: jest.fn(),
  listMemoriesBySourceMessageId: jest.fn(),
}))
const mockList = listMemoriesBySourceMessageId as jest.Mock
const mockGet = getMemory as jest.Mock

function memory(id: string): Memory {
  return { id, text: `text-${id}` } as Memory
}

beforeEach(() => {
  jest.clearAllMocks()
  lastQuerier = undefined
  liveResult = undefined
})

describe("useLearnedMemories", () => {
  it("returns [] while the live query is still loading", () => {
    const { result } = renderHook(() => useLearnedMemories("msg-1"))
    expect(result.current).toEqual([])
  })

  it("queries by messageId and returns the live rows", async () => {
    const rows = [memory("m1"), memory("m2")]
    mockList.mockResolvedValue(rows)
    liveResult = rows
    const { result } = renderHook(() => useLearnedMemories("msg-1"))
    expect(result.current).toEqual(rows)
    await expect(lastQuerier!()).resolves.toEqual(rows)
    expect(mockList).toHaveBeenCalledWith("msg-1")
  })

  it("resolves to [] without querying when messageId is absent", async () => {
    renderHook(() => useLearnedMemories(undefined))
    await expect(lastQuerier!()).resolves.toEqual([])
    expect(mockList).not.toHaveBeenCalled()
  })
})

describe("useRecalledMemories", () => {
  it("resolves ids in order and keeps deleted rows as id-only refs", async () => {
    mockGet.mockImplementation(async (id: string) => (id === "gone" ? undefined : memory(id)))
    renderHook(() => useRecalledMemories(["a", "gone", "b"]))
    await expect(lastQuerier!()).resolves.toEqual([
      { id: "a", memory: memory("a") },
      { id: "gone", memory: undefined },
      { id: "b", memory: memory("b") },
    ])
  })

  it("short-circuits to [] for an empty id list", async () => {
    renderHook(() => useRecalledMemories([]))
    await expect(lastQuerier!()).resolves.toEqual([])
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("returns [] while loading and the live rows once resolved", () => {
    const refs = [{ id: "a", memory: memory("a") }]
    const { result, rerender } = renderHook(() => useRecalledMemories(["a"]))
    expect(result.current).toEqual([])
    liveResult = refs
    rerender()
    expect(result.current).toEqual(refs)
  })
})
