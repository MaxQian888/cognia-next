/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

const mockUseLiveQuery = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockUseLiveQuery(),
}))

jest.mock("@/lib/db/connector-drafts", () => ({
  listAllPendingDrafts: jest.fn(),
}))

import { usePendingDrafts, usePendingDraftCounts } from "./use-pending-drafts"

const DRAFTS = [
  { id: "d1", conversationKey: "slack:a1:C1", status: "pending", createdAt: 3, segments: [] },
  { id: "d2", conversationKey: "slack:a1:C1", status: "pending", createdAt: 2, segments: [] },
  { id: "d3", conversationKey: "lark:a2:U9", status: "pending", createdAt: 1, segments: [] },
]

describe("usePendingDrafts", () => {
  it("returns the live-queried rows", () => {
    mockUseLiveQuery.mockReturnValue(DRAFTS)
    const { result } = renderHook(() => usePendingDrafts())
    expect(result.current).toHaveLength(3)
  })

  it("falls back to an empty array before the query resolves", () => {
    mockUseLiveQuery.mockReturnValue(undefined)
    const { result } = renderHook(() => usePendingDrafts())
    expect(result.current).toEqual([])
  })
})

describe("usePendingDraftCounts", () => {
  it("groups pending drafts by conversationKey", () => {
    mockUseLiveQuery.mockReturnValue(DRAFTS)
    const { result } = renderHook(() => usePendingDraftCounts())
    expect(result.current.get("slack:a1:C1")).toBe(2)
    expect(result.current.get("lark:a2:U9")).toBe(1)
    expect(result.current.get("missing")).toBeUndefined()
  })

  it("returns an empty map when there are no drafts", () => {
    mockUseLiveQuery.mockReturnValue([])
    const { result } = renderHook(() => usePendingDraftCounts())
    expect(result.current.size).toBe(0)
  })
})
