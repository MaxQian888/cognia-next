/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

let activeSessionId: string | null = "s1"
jest.mock("@/stores/chat", () => ({
  useChatStore: (sel: (s: { activeSessionId: string | null }) => unknown) =>
    sel({ activeSessionId }),
}))

const getSessionMcpStatus = jest.fn()
const reconnectSessionMcpServer = jest.fn()
const toggleSessionMcpServer = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  getSessionMcpStatus: (...a: unknown[]) => getSessionMcpStatus(...a),
  reconnectSessionMcpServer: (...a: unknown[]) => reconnectSessionMcpServer(...a),
  toggleSessionMcpServer: (...a: unknown[]) => toggleSessionMcpServer(...a),
}))

const useMcpServerLogs = jest.fn()
jest.mock("@/hooks/mcp/use-mcp-server-logs", () => ({
  mcpServerLogsHref: (s: string) => `/logs?src=mcp&module=mcp:${s}`,
  useMcpServerLogs: (...a: unknown[]) => useMcpServerLogs(...a),
}))

const EMPTY_LOGS = { logs: [], lastEntry: null, lastError: null, errorCount: 0, isLoading: false }

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import type { SdkMcpServerStatus } from "@/lib/claude/types"
import { McpLiveSessionCard } from "./mcp-live-session-card"

const mockToast = toast as unknown as { success: jest.Mock; error: jest.Mock }

const failedRow: SdkMcpServerStatus = { name: "github", status: "failed", error: "ECONNREFUSED" }
const okRow: SdkMcpServerStatus = {
  name: "cognia",
  status: "connected",
  tools: [{ name: "a" }, { name: "b" }],
}

beforeEach(() => {
  jest.clearAllMocks()
  activeSessionId = "s1"
  mockIsTauri.mockReturnValue(true)
  useMcpServerLogs.mockReturnValue(EMPTY_LOGS)
})

describe("McpLiveSessionCard", () => {
  it("renders live server rows with status badges and tool counts", async () => {
    getSessionMcpStatus.mockResolvedValue([okRow, failedRow])
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-github")).toBeInTheDocument())
    expect(screen.getByTestId("mcp-live-row-cognia")).toBeInTheDocument()
    expect(screen.getByText("status.connected")).toBeInTheDocument()
    expect(screen.getByText("status.failed")).toBeInTheDocument()
    // Tool count uses the {count} interpolation.
    expect(screen.getByText('toolsCount:{"count":2}')).toBeInTheDocument()
    expect(screen.getByText("ECONNREFUSED")).toBeInTheDocument()
  })

  it("shows a Reconnect button only for failed/needs-auth servers", async () => {
    getSessionMcpStatus.mockResolvedValue([okRow, failedRow])
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-github")).toBeInTheDocument())
    // One reconnect button (for the failed github row, not the connected one).
    expect(screen.getAllByText("reconnect")).toHaveLength(1)
  })

  it("reconnects a failed server and refreshes", async () => {
    getSessionMcpStatus.mockResolvedValueOnce([failedRow]).mockResolvedValueOnce([okRow])
    reconnectSessionMcpServer.mockResolvedValue(undefined)
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-github")).toBeInTheDocument())
    fireEvent.click(screen.getByText("reconnect"))
    await waitFor(() => expect(reconnectSessionMcpServer).toHaveBeenCalledWith("s1", "github"))
    expect(getSessionMcpStatus).toHaveBeenCalledTimes(2)
  })

  it("toggles a server enabled/disabled", async () => {
    getSessionMcpStatus.mockResolvedValue([okRow])
    toggleSessionMcpServer.mockResolvedValue(undefined)
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-cognia")).toBeInTheDocument())
    fireEvent.click(screen.getByText("disable"))
    // connected (not disabled) → toggle to disabled = false.
    await waitFor(() => expect(toggleSessionMcpServer).toHaveBeenCalledWith("s1", "cognia", false))
  })

  it("renders the empty hint when the session has no servers", async () => {
    getSessionMcpStatus.mockResolvedValue([])
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByText("empty")).toBeInTheDocument())
  })

  it("hides itself when there is no active session", () => {
    activeSessionId = null
    const { queryByTestId } = render(<McpLiveSessionCard />)
    expect(queryByTestId("mcp-live-session-card")).toBeNull()
    expect(getSessionMcpStatus).not.toHaveBeenCalled()
  })

  it("hides itself when the control call rejects (ai-sdk / no session)", async () => {
    getSessionMcpStatus.mockRejectedValue(new Error("unsupported_provider"))
    const { queryByTestId } = render(<McpLiveSessionCard />)
    await waitFor(() => expect(queryByTestId("mcp-live-session-card")).toBeNull())
  })

  it("hides itself in web mode", () => {
    mockIsTauri.mockReturnValue(false)
    const { queryByTestId } = render(<McpLiveSessionCard />)
    expect(queryByTestId("mcp-live-session-card")).toBeNull()
  })

  it("re-fetches when the Refresh button is clicked", async () => {
    getSessionMcpStatus.mockResolvedValue([okRow])
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-cognia")).toBeInTheDocument())
    getSessionMcpStatus.mockClear()
    fireEvent.click(screen.getByLabelText("refresh"))
    await waitFor(() => expect(getSessionMcpStatus).toHaveBeenCalledTimes(1))
  })

  it("toasts an error when reconnect fails", async () => {
    getSessionMcpStatus.mockResolvedValue([failedRow])
    reconnectSessionMcpServer.mockRejectedValue(new Error("boom"))
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-github")).toBeInTheDocument())
    fireEvent.click(screen.getByText("reconnect"))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("boom"))
  })

  it("hides the card when a manual refresh fails", async () => {
    getSessionMcpStatus.mockResolvedValueOnce([okRow]).mockRejectedValueOnce(new Error("x"))
    const { queryByTestId } = render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-cognia")).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText("refresh"))
    await waitFor(() => expect(queryByTestId("mcp-live-session-card")).toBeNull())
  })

  it("offers Reconnect for needs-auth and Enable for disabled servers", async () => {
    getSessionMcpStatus.mockResolvedValue([
      { name: "auth", status: "needs-auth" },
      { name: "off", status: "disabled" },
    ] as SdkMcpServerStatus[])
    toggleSessionMcpServer.mockResolvedValue(undefined)
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-auth")).toBeInTheDocument())
    // needs-auth → reconnect available.
    expect(screen.getByText("reconnect")).toBeInTheDocument()
    // disabled → the toggle reads "enable" and flips to enabled=true.
    fireEvent.click(screen.getByText("enable"))
    await waitFor(() => expect(toggleSessionMcpServer).toHaveBeenCalledWith("s1", "off", true))
  })

  it("drops a stale status write after the session changes mid-operation", async () => {
    let resolveReconnectFetch: (v: SdkMcpServerStatus[]) => void = () => {}
    getSessionMcpStatus
      .mockResolvedValueOnce([failedRow]) // s1 mount
      .mockImplementationOnce(
        () =>
          new Promise<SdkMcpServerStatus[]>((res) => {
            resolveReconnectFetch = res
          })
      ) // s1 reconnect refetch (deferred)
      .mockResolvedValueOnce([okRow]) // s2 mount
    reconnectSessionMcpServer.mockResolvedValue(undefined)
    const { rerender } = render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-github")).toBeInTheDocument())
    fireEvent.click(screen.getByText("reconnect"))
    await waitFor(() => expect(reconnectSessionMcpServer).toHaveBeenCalledWith("s1", "github"))
    // Switch sessions — the mount effect loads s2's rows (cognia).
    activeSessionId = "s2"
    rerender(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-cognia")).toBeInTheDocument())
    // The stale s1 reconnect fetch resolves late with old (failed) data — the
    // session guard must drop it so s2's view is not clobbered.
    resolveReconnectFetch([failedRow])
    await waitFor(() => expect(screen.queryByTestId("mcp-live-row-github")).toBeNull())
    expect(screen.getByTestId("mcp-live-row-cognia")).toBeInTheDocument()
  })

  it("links each row to its per-server log view", async () => {
    getSessionMcpStatus.mockResolvedValue([failedRow])
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-github")).toBeInTheDocument())
    expect(screen.getByLabelText('viewLogsFor:{"name":"github"}')).toHaveAttribute(
      "href",
      "/logs?src=mcp&module=mcp:github"
    )
  })

  it("surfaces the most recent bridged error line when the SDK reports none", async () => {
    useMcpServerLogs.mockReturnValue({
      ...EMPTY_LOGS,
      lastError: { message: "stderr boom", timestamp: new Date().toISOString(), level: "error" },
      errorCount: 1,
    })
    getSessionMcpStatus.mockResolvedValue([okRow]) // connected → no srv.error
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-cognia")).toBeInTheDocument())
    expect(screen.getByTitle("stderr boom")).toBeInTheDocument()
  })

  it("self-refreshes a pending server until it settles (no manual refresh needed)", async () => {
    jest.useFakeTimers()
    try {
      getSessionMcpStatus
        .mockResolvedValueOnce([{ name: "warm", status: "pending" } as SdkMcpServerStatus])
        .mockResolvedValueOnce([{ name: "warm", status: "connected" } as SdkMcpServerStatus])
      render(<McpLiveSessionCard />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByText("status.pending")).toBeInTheDocument()
      // The bounded poll fires after ~2.5s and picks up the settled status.
      await act(async () => {
        jest.advanceTimersByTime(2600)
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByText("status.connected")).toBeInTheDocument()
      expect(getSessionMcpStatus).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it("stops self-refreshing a permanently failed server once the poll budget is spent", async () => {
    jest.useFakeTimers()
    try {
      getSessionMcpStatus.mockResolvedValue([failedRow])
      render(<McpLiveSessionCard />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByTestId("mcp-live-row-github")).toBeInTheDocument()
      // Burn well past the 6-poll budget.
      for (let i = 0; i < 10; i++) {
        await act(async () => {
          jest.advanceTimersByTime(2600)
        })
        await act(async () => {
          await Promise.resolve()
        })
      }
      // 1 initial load + at most 6 budgeted polls.
      expect(getSessionMcpStatus.mock.calls.length).toBeLessThanOrEqual(7)
      expect(getSessionMcpStatus.mock.calls.length).toBe(7)
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not self-refresh when every server is settled", async () => {
    jest.useFakeTimers()
    try {
      getSessionMcpStatus.mockResolvedValue([okRow])
      render(<McpLiveSessionCard />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByTestId("mcp-live-row-cognia")).toBeInTheDocument()
      await act(async () => {
        jest.advanceTimersByTime(10_000)
      })
      expect(getSessionMcpStatus).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it("toasts an error when toggle fails", async () => {
    getSessionMcpStatus.mockResolvedValue([okRow])
    toggleSessionMcpServer.mockRejectedValue(new Error("nope"))
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-cognia")).toBeInTheDocument())
    fireEvent.click(screen.getByText("disable"))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("nope"))
  })
})
