/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import MobileExternalAgentsPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { transport } from "@/lib/tauri"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"

jest.mock("@/hooks/companion/use-companion-config")
jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))
jest.mock("@/lib/tauri/admin-lease", () => ({ issueHostAdminLease: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const callMock = transport.call as jest.Mock
const issueLeaseMock = issueHostAdminLease as jest.Mock

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
  issueLeaseMock.mockResolvedValue({ token: "lease-1" })
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

  it("sends an enable/disable toggle with a fresh approval lease", async () => {
    render(<MobileExternalAgentsPage />)
    await waitFor(() => expect(screen.getByTestId("external-agent-switch-a1")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("external-agent-switch-a1"))
    await waitFor(() => expect(issueLeaseMock).toHaveBeenCalledWith(["external_agent_update"]))
    expect(callMock).toHaveBeenLastCalledWith("external_agent_update", {
      id: "a1",
      patch: { enabled: false },
      adminLease: "lease-1",
    })
  })
})
