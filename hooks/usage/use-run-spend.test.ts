/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { SessionUsageRow } from "@/lib/db/session-usage"

jest.mock("@/hooks/data/use-client-live-query", () => ({ useClientLiveQuery: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { getDb } from "@/lib/db/schema"
import { useRunSpend } from "./use-run-spend"

const mockWhere = jest.fn()
const mockEquals = jest.fn()
const mockToArray = jest.fn()

function row(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: "message-1",
    sessionId: "goal:g",
    at: 1,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 20,
    cacheCreationTokens: 5,
    costUsd: 0.25,
    costSource: "derived",
    costKnown: true,
    durationMs: 0,
    ...overrides,
  }
}

beforeEach(() => {
  jest
    .mocked(useClientLiveQuery)
    .mockReset()
    .mockImplementation((query) => query() as never)
  mockWhere.mockReset().mockReturnValue({ equals: mockEquals })
  mockEquals.mockReset().mockReturnValue({ toArray: mockToArray })
  mockToArray.mockReset().mockReturnValue([])
  jest
    .mocked(getDb)
    .mockReset()
    .mockReturnValue({ sessionUsage: { where: mockWhere } } as unknown as ReturnType<typeof getDb>)
})

it("stays idle for null and does not open the database", () => {
  const { result } = renderHook(() => useRunSpend(null))
  expect(result.current).toBeNull()
  expect(getDb).not.toHaveBeenCalled()
  expect(useClientLiveQuery).toHaveBeenLastCalledWith(expect.any(Function), [null], [])
})

it("queries only the requested grouping key and sums all token classes and frozen costs", () => {
  mockToArray.mockReturnValue([row(), row({ messageId: "message-2", costUsd: 0.5 })])
  const { result } = renderHook(() => useRunSpend("goal:g"))
  expect(mockWhere).toHaveBeenCalledWith("sessionId")
  expect(mockEquals).toHaveBeenCalledWith("goal:g")
  expect(result.current).toEqual({ costUsd: 0.75, tokens: 270 })
})

it("keeps cost unknown if any turn is unpriced and observes ledger updates", () => {
  mockToArray.mockReturnValue([row()])
  const { result, rerender } = renderHook(() => useRunSpend("goal:g"))
  expect(result.current).toEqual({ costUsd: 0.25, tokens: 135 })
  mockToArray.mockReturnValue([row(), row({ costUsd: 0, costSource: "unknown", costKnown: false })])
  rerender()
  expect(result.current).toEqual({ costUsd: null, tokens: 270 })
})

it("changes the query subscription with the run and returns to idle on null", () => {
  mockToArray.mockReturnValue([row()])
  const { result, rerender } = renderHook(({ id }) => useRunSpend(id), {
    initialProps: { id: "goal:g" as string | null },
  })
  mockToArray.mockReturnValue([])
  rerender({ id: "team:t" })
  expect(mockEquals).toHaveBeenLastCalledWith("team:t")
  expect(useClientLiveQuery).toHaveBeenLastCalledWith(expect.any(Function), ["team:t"], [])
  expect(result.current).toEqual({ costUsd: null, tokens: null })
  const reads = jest.mocked(getDb).mock.calls.length
  rerender({ id: null })
  expect(result.current).toBeNull()
  expect(getDb).toHaveBeenCalledTimes(reads)
})

it("does not present spend while the live query has no result", () => {
  jest.mocked(useClientLiveQuery).mockReturnValue(undefined)
  const { result } = renderHook(() => useRunSpend("goal:g"))
  expect(result.current).toBeNull()
})
