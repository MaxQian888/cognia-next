/**
 * @jest-environment jsdom
 */

let mockStatus = "idle"
let mockSessionStatus = "idle"
let mockRuntime = "claude-agent-sdk"
jest.mock("@/stores/chat", () => ({
  useSessionStatus: (sessionId: string | null) => (sessionId === "s1" ? mockSessionStatus : "idle"),
  useChatStore: (sel: (s: unknown) => unknown) =>
    sel({
      status: mockStatus,
      sessions: { s1: { status: mockSessionStatus } },
      lastSendBySession: {
        s1: { options: { execution: { hostRef: "desktop-sidecar", runtimeAdapter: mockRuntime } } },
      },
    }),
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
  mockSessionStatus = "idle"
  mockRuntime = "claude-agent-sdk"
  mockHostProfile.mockReturnValue("desktop")
})

describe("useSdkContextUsage", () => {
  it("re-probes when the same provider switches its live runtime", async () => {
    mockRuntime = "ai-sdk"
    getSessionContextUsage.mockRejectedValue(new Error("unsupported"))
    const { result, rerender } = renderHook(() => useSdkContextUsage("s1", "custom"))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.snapshot).toBeNull()
    getSessionContextUsage.mockResolvedValue(SNAP)
    mockRuntime = "claude-agent-sdk"
    rerender()
    await waitFor(() => expect(result.current.snapshot).toEqual(SNAP))
  })

  it("fetches SDK usage on mount for an Anthropic session", async () => {
    getSessionContextUsage.mockResolvedValue(SNAP)
    const { result } = renderHook(() => useSdkContextUsage("s1", "anthropic"))
    await waitFor(() => expect(result.current.snapshot).toEqual(SNAP))
    expect(getSessionContextUsage).toHaveBeenCalledWith("s1")
  })

  it("probes the live runtime for a custom provider", async () => {
    getSessionContextUsage.mockResolvedValue(SNAP)
    const { result } = renderHook(() => useSdkContextUsage("s1", "custom-anthropic"))
    await act(async () => {
      await Promise.resolve()
    })
    expect(getSessionContextUsage).toHaveBeenCalledWith("s1")
    expect(result.current.snapshot).toEqual(SNAP)
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
    mockSessionStatus = "streaming"
    const { rerender } = renderHook(() => useSdkContextUsage("s1"))
    await waitFor(() => expect(getSessionContextUsage).toHaveBeenCalled())
    getSessionContextUsage.mockClear()
    mockSessionStatus = "idle"
    rerender()
    await waitFor(() => expect(getSessionContextUsage).toHaveBeenCalledWith("s1"))
  })

  it("ignores completion in another session while its own session remains idle", async () => {
    getSessionContextUsage.mockResolvedValue(SNAP)
    mockStatus = "streaming"
    const { rerender } = renderHook(() => useSdkContextUsage("s1"))
    await waitFor(() => expect(getSessionContextUsage).toHaveBeenCalledTimes(1))
    mockStatus = "idle"
    rerender()
    await act(async () => {
      await Promise.resolve()
    })
    expect(getSessionContextUsage).toHaveBeenCalledTimes(1)
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
  it("ignores stale responses across session switches including A to B to A", async () => {
    const pending: Array<(value: typeof SNAP) => void> = []
    getSessionContextUsage.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    const { result, rerender } = renderHook(({ id }) => useSdkContextUsage(id), {
      initialProps: { id: "a" },
    })
    await waitFor(() => expect(pending).toHaveLength(1))
    rerender({ id: "b" })
    await waitFor(() => expect(pending).toHaveLength(2))
    rerender({ id: "a" })
    await waitFor(() => expect(pending).toHaveLength(3))
    const fresh = { ...SNAP, totalTokens: 30 }
    await act(async () => pending[2](fresh))
    await act(async () => pending[0](SNAP))
    await act(async () => pending[1](SNAP))
    expect(result.current.snapshot).toEqual(fresh)
  })

  it("does not repeatedly probe an unsupported runtime", async () => {
    getSessionContextUsage.mockRejectedValue(new Error("unsupported_provider"))

    const { result } = renderHook(() => useSdkContextUsage("s1", "other-provider"))
    await act(async () => {
      await Promise.resolve()
    })
    act(() => result.current.refresh())
    await act(async () => {
      await Promise.resolve()
    })
    expect(getSessionContextUsage).toHaveBeenCalledTimes(1)
  })
})
