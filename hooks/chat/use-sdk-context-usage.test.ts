/**
 * @jest-environment jsdom
 */

let mockStatus = "idle"
jest.mock("@/stores/chat", () => ({
  useChatStore: (sel: (s: { status: string }) => unknown) => sel({ status: mockStatus }),
}))

const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))

const getSessionContextUsage = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  getSessionContextUsage: (...a: unknown[]) => getSessionContextUsage(...a),
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { useSdkContextUsage } from "./use-sdk-context-usage"

const SNAP = { totalTokens: 10, maxTokens: 100, percentage: 0.1 }

beforeEach(() => {
  jest.clearAllMocks()
  mockStatus = "idle"
  mockIsTauri.mockReturnValue(true)
})

describe("useSdkContextUsage", () => {
  it("fetches SDK usage on mount for an Anthropic session", async () => {
    getSessionContextUsage.mockResolvedValue(SNAP)
    const { result } = renderHook(() => useSdkContextUsage("s1", "anthropic"))
    await waitFor(() => expect(result.current.snapshot).toEqual(SNAP))
    expect(getSessionContextUsage).toHaveBeenCalledWith("s1")
  })

  it("stays disabled for non-Anthropic providers", async () => {
    getSessionContextUsage.mockResolvedValue(SNAP)
    const { result } = renderHook(() => useSdkContextUsage("s1", "openai"))
    await act(async () => {
      await Promise.resolve()
    })
    expect(getSessionContextUsage).not.toHaveBeenCalled()
    expect(result.current.snapshot).toBeNull()
  })

  it("is disabled in web mode", async () => {
    mockIsTauri.mockReturnValue(false)
    renderHook(() => useSdkContextUsage("s1", "anthropic"))
    await act(async () => {
      await Promise.resolve()
    })
    expect(getSessionContextUsage).not.toHaveBeenCalled()
  })

  it("clears the snapshot when the control call rejects", async () => {
    getSessionContextUsage.mockRejectedValue(new Error("no_active_session"))
    const { result } = renderHook(() => useSdkContextUsage("s1"))
    await waitFor(() => expect(getSessionContextUsage).toHaveBeenCalled())
    expect(result.current.snapshot).toBeNull()
  })

  it("refreshes once after a turn completes (busy → idle)", async () => {
    getSessionContextUsage.mockResolvedValue(SNAP)
    mockStatus = "streaming"
    const { rerender } = renderHook(() => useSdkContextUsage("s1"))
    await waitFor(() => expect(getSessionContextUsage).toHaveBeenCalled())
    getSessionContextUsage.mockClear()
    mockStatus = "idle"
    rerender()
    await waitFor(() => expect(getSessionContextUsage).toHaveBeenCalledWith("s1"))
  })

  it("exposes a manual refresh", async () => {
    getSessionContextUsage.mockResolvedValue(SNAP)
    const { result } = renderHook(() => useSdkContextUsage("s1"))
    await waitFor(() => expect(getSessionContextUsage).toHaveBeenCalled())
    getSessionContextUsage.mockClear()
    act(() => result.current.refresh())
    await waitFor(() => expect(getSessionContextUsage).toHaveBeenCalledWith("s1"))
  })

  it("does nothing without a session id", async () => {
    renderHook(() => useSdkContextUsage(null))
    await act(async () => {
      await Promise.resolve()
    })
    expect(getSessionContextUsage).not.toHaveBeenCalled()
  })
})
