/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import MobileExternalAgentsPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { transport } from "@/lib/tauri"
import { enqueue } from "@/lib/db/mobile-outbound-queue"

jest.mock("@/hooks/companion/use-companion-config")
jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ enqueue: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const callMock = transport.call as jest.Mock
const enqueueMock = enqueue as jest.Mock

const AGENTS = [
  {
    id: "a1",
    name: "Claude Code",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    defaultPermissionMode: "default",
  },
  {
    id: "a2",
    name: "Codex",
    protocol: "codex-app-server",
    transport: "stdio",
    enabled: false,
    defaultPermissionMode: "plan",
  },
]

const mockPaired = (paired: boolean) =>
  (useCompanionConfig as jest.Mock).mockReturnValue({
    config: null,
    paired,
    shortDeviceId: null,
    loading: false,
    reload: jest.fn(),
  })

beforeEach(() => {
  jest.clearAllMocks()
  mockPaired(true)
  callMock.mockResolvedValue({ agents: AGENTS })
  enqueueMock.mockResolvedValue({ id: "q1" })
})

describe("MobileExternalAgentsPage", () => {
  it("shows the paired placeholder when unpaired", () => {
    mockPaired(false)
    render(<MobileExternalAgentsPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("me-section-external-agents")).toBeNull()
  })

  it("lists agents fetched through the external_agent_list RPC", async () => {
    render(<MobileExternalAgentsPage />)
    await waitFor(() => expect(screen.getByTestId("external-agent-row-a1")).toBeInTheDocument())
    expect(callMock).toHaveBeenCalledWith("external_agent_list", {})
    expect(screen.getByText("Claude Code")).toBeInTheDocument()
    expect(screen.getByText("Codex")).toBeInTheDocument()
    // a1 enabled, a2 disabled.
    expect(screen.getByTestId("external-agent-switch-a1")).toBeChecked()
    expect(screen.getByTestId("external-agent-switch-a2")).not.toBeChecked()
  })

  it("renders the empty state when no agents are configured", async () => {
    callMock.mockResolvedValue({ agents: [] })
    render(<MobileExternalAgentsPage />)
    await waitFor(() => expect(screen.getByTestId("external-agents-empty")).toBeInTheDocument())
  })

  it("surfaces a load failure", async () => {
    callMock.mockRejectedValue(new Error("offline"))
    render(<MobileExternalAgentsPage />)
    await waitFor(() => expect(screen.getByTestId("external-agents-error")).toBeInTheDocument())
  })

  it("queues an enable/disable toggle through external_agent_update", async () => {
    render(<MobileExternalAgentsPage />)
    await waitFor(() => expect(screen.getByTestId("external-agent-switch-a1")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("external-agent-switch-a1"))
    await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
    const arg = enqueueMock.mock.calls[0][0] as {
      command: string
      payload: { id: string; patch: Record<string, unknown> }
    }
    expect(arg.command).toBe("external_agent_update")
    expect(arg.payload.id).toBe("a1")
    expect(arg.payload.patch).toEqual({ enabled: false })
  })
})
