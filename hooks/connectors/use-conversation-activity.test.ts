/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

const mockUseLiveQuery = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockUseLiveQuery(),
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

import {
  useConversationActivity,
  isActivityKind,
  ACTIVITY_KINDS,
} from "./use-conversation-activity"

describe("isActivityKind", () => {
  it("accepts curated system-event kinds", () => {
    expect(isActivityKind("inbound.edited")).toBe(true)
    expect(isActivityKind("inbound.member_added")).toBe(true)
    expect(isActivityKind("override.computer_use_changed")).toBe(true)
  })

  it("rejects non-activity kinds", () => {
    expect(isActivityKind("inbound.received")).toBe(false)
    expect(isActivityKind("delivery.success")).toBe(false)
    expect(isActivityKind("adapter.heartbeat")).toBe(false)
  })

  it("covers exactly the 12 curated kinds", () => {
    expect(ACTIVITY_KINDS.size).toBe(12)
  })
})

describe("useConversationActivity", () => {
  it("returns the live-queried entries", () => {
    const rows = [{ id: "e1", kind: "inbound.edited", at: 5 }]
    mockUseLiveQuery.mockReturnValue(rows)
    const { result } = renderHook(() => useConversationActivity("ck"))
    expect(result.current).toBe(rows)
  })

  it("falls back to an empty array before the query resolves", () => {
    mockUseLiveQuery.mockReturnValue(undefined)
    const { result } = renderHook(() => useConversationActivity("ck"))
    expect(result.current).toEqual([])
  })
})
