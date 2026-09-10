/**
 * @jest-environment jsdom
 */

let mockStatus = "idle"
jest.mock("@/stores/chat", () => ({
  useChatStore: (sel: (s: { status: string }) => unknown) => sel({ status: mockStatus }),
}))

// The host gate reads the host PROFILE (this shell's own sidecar, or a paired
// host's over the companion transport), not the webview kind.
const mockHostProfile = jest.fn((): string => "desktop")
jest.mock("@/lib/platform/capabilities", () => ({
  ...jest.requireActual("@/lib/platform/capabilities"),
  detectHostProfile: () => mockHostProfile(),
}))

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
  mockHostProfile.mockReturnValue("desktop")
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

  it("is disabled in a standalone browser, which has no host to ask", async () => {
    mockHostProfile.mockReturnValue("web-standalone")
    renderHook(() => useSdkContextUsage("s1", "anthropic"))
    await act(async () => {
      await Promise.resolve()
    })
    expect(getSessionContextUsage).not.toHaveBeenCalled()
  })

  it.each(["mobile-companion", "cloud-companion", "headless"])(
    "fetches from a %s shell, whose host owns or reaches the sidecar",
    async (profile) => {
      mockHostProfile.mockReturnValue(profile)
      getSessionContextUsage.mockResolvedValue(SNAP)
      const { result } = renderHook(() => useSdkContextUsage("s1", "anthropic"))
      await waitFor(() => expect(result.current.snapshot).toEqual(SNAP))
      expect(getSessionContextUsage).toHaveBeenCalledWith("s1")
    }
  )

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
