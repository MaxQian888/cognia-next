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

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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

  it("toasts an error when toggle fails", async () => {
    getSessionMcpStatus.mockResolvedValue([okRow])
    toggleSessionMcpServer.mockRejectedValue(new Error("nope"))
    render(<McpLiveSessionCard />)
    await waitFor(() => expect(screen.getByTestId("mcp-live-row-cognia")).toBeInTheDocument())
    fireEvent.click(screen.getByText("disable"))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("nope"))
  })
})
