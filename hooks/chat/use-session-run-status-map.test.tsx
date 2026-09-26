/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

let mockState: { sessions?: Record<string, { status?: string } | undefined> } = {}
jest.mock("@/stores/chat", () => ({
  useChatStore: <T,>(selector: (s: typeof mockState) => T): T => selector(mockState),
}))

import { useSessionRunStatusMap } from "./use-session-run-status-map"

describe("useSessionRunStatusMap", () => {
  it("keeps only sessions with a non-idle turn state", () => {
    mockState = {
      sessions: {
        idle: { status: "idle" },
        run: { status: "streaming" },
        ask: { status: "awaiting_approval" },
        err: { status: "error" },
        gone: undefined,
      },
    }
    const { result } = renderHook(() => useSessionRunStatusMap())
    expect(Object.fromEntries(result.current)).toEqual({
      run: "streaming",
      ask: "awaiting_approval",
      err: "error",
    })
  })

  it("is empty before any session slice exists", () => {
    mockState = {}
    const { result } = renderHook(() => useSessionRunStatusMap())
    expect(result.current.size).toBe(0)
  })

  it("keeps its identity while no status changes", () => {
    mockState = { sessions: { run: { status: "streaming" } } }
    const { result, rerender } = renderHook(() => useSessionRunStatusMap())
    const first = result.current
    mockState = { sessions: { run: { status: "streaming" } } }
    rerender()
    expect(result.current).toBe(first)
  })
})
