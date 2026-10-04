/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

import { transport } from "@/lib/tauri"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"

import { DesktopLocalAgents, type DesktopLocalAgentSummary } from "./desktop-local-agents"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))
jest.mock("@/lib/tauri/admin-lease", () => ({ issueHostAdminLease: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const callMock = transport.call as jest.Mock
const issueLeaseMock = issueHostAdminLease as jest.Mock
const toastSuccess = toast.success as jest.Mock
const toastError = toast.error as jest.Mock

// Radix Select needs pointer and scroll APIs jsdom lacks.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
  Element.prototype.hasPointerCapture = jest.fn(() => false)
  Element.prototype.setPointerCapture = jest.fn()
  Element.prototype.releasePointerCapture = jest.fn()
})

const AGENTS: DesktopLocalAgentSummary[] = [
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

/** Answers the list read with `agents` and every update with `update`. */
function routeCalls(agents: unknown, update: () => Promise<unknown> = async () => ({})) {
  callMock.mockImplementation((command: string) =>
    command === "external_agent_list" ? Promise.resolve(agents) : update()
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  routeCalls({ agents: AGENTS })
  issueLeaseMock.mockResolvedValue({ token: "lease-1" })
})

describe("DesktopLocalAgents", () => {
  it("lists agents fetched through the external_agent_list RPC", async () => {
    render(<DesktopLocalAgents />)
    await waitFor(() => expect(screen.getByTestId("external-agent-row-a1")).toBeInTheDocument())
    expect(callMock).toHaveBeenCalledWith("external_agent_list", {})
    expect(screen.getByTestId("desktop-local-agents")).toHaveTextContent("Desktop-only agents")
    expect(screen.getByText("Claude Code")).toBeInTheDocument()
    expect(screen.getByText("Codex")).toBeInTheDocument()
    expect(screen.getByTestId("external-agent-switch-a1")).toBeChecked()
    expect(screen.getByTestId("external-agent-switch-a2")).not.toBeChecked()
  })

  it("renders nothing when the desktop has no agents of its own", async () => {
    routeCalls({ agents: [] })
    const { container } = render(<DesktopLocalAgents />)
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("external_agent_list", {}))
    // Let the resolved list land, so this is the loaded render and not the initial one.
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId("desktop-local-agents")).toBeNull()
  })

  it("renders nothing for a response without an agents list", async () => {
    routeCalls(null)
    const { container } = render(<DesktopLocalAgents />)
    await waitFor(() => expect(callMock).toHaveBeenCalled())
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })

  it("surfaces a load failure", async () => {
    callMock.mockRejectedValue(new Error("offline"))
    render(<DesktopLocalAgents />)
    expect(await screen.findByTestId("desktop-local-agents-error")).toHaveTextContent(
      "Could not load external agents: offline"
    )
  })

  it("sends an enable/disable toggle with a fresh approval lease", async () => {
    render(<DesktopLocalAgents />)
    fireEvent.click(await screen.findByTestId("external-agent-switch-a1"))
    // Optimistic: the switch flips before the write resolves.
    expect(screen.getByTestId("external-agent-switch-a1")).not.toBeChecked()
    await waitFor(() => expect(issueLeaseMock).toHaveBeenCalledWith(["external_agent_update"]))
    await waitFor(() =>
      expect(callMock).toHaveBeenLastCalledWith("external_agent_update", {
        id: "a1",
        patch: { enabled: false },
        adminLease: "lease-1",
      })
    )
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Change saved on the Host."))
    expect(screen.getByTestId("external-agent-switch-a1")).not.toBeChecked()
  })

  it("rolls the toggle back when the write fails", async () => {
    routeCalls({ agents: AGENTS }, async () => {
      throw new Error("denied")
    })
    render(<DesktopLocalAgents />)
    fireEvent.click(await screen.findByTestId("external-agent-switch-a1"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not save the change: denied")
    )
    expect(screen.getByTestId("external-agent-switch-a1")).toBeChecked()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("rolls the toggle back when no lease can be issued", async () => {
    issueLeaseMock.mockRejectedValue(new Error("no lease"))
    render(<DesktopLocalAgents />)
    fireEvent.click(await screen.findByTestId("external-agent-switch-a2"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not save the change: no lease")
    )
    expect(screen.getByTestId("external-agent-switch-a2")).not.toBeChecked()
    expect(callMock).not.toHaveBeenCalledWith("external_agent_update", expect.anything())
  })

  it("changes the permission mode with a fresh approval lease", async () => {
    const user = userEvent.setup()
    render(<DesktopLocalAgents />)
    await user.click(await screen.findByTestId("external-agent-mode-a1"))
    await user.click(await screen.findByRole("option", { name: "Plan" }))
    await waitFor(() =>
      expect(callMock).toHaveBeenLastCalledWith("external_agent_update", {
        id: "a1",
        patch: { defaultPermissionMode: "plan" },
        adminLease: "lease-1",
      })
    )
    expect(screen.getByTestId("external-agent-mode-a1")).toHaveTextContent("Plan")
  })

  it("clamps the shown mode and the choices to what the protocol can run", async () => {
    const user = userEvent.setup()
    routeCalls({
      agents: [
        {
          id: "r1",
          name: "Remote",
          protocol: "a2a",
          transport: "http",
          enabled: true,
          defaultPermissionMode: "bypassPermissions",
        },
      ],
    })
    render(<DesktopLocalAgents />)
    const trigger = await screen.findByTestId("external-agent-mode-r1")
    expect(trigger).toHaveTextContent("Default")

    await user.click(trigger)
    const options = await screen.findAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual(["Default"])
  })
})
