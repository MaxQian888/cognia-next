/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

import { MobileFleetRow } from "./mobile-fleet-row"
import type { FleetSession } from "@/lib/fleet/types"

// The permission actions + reply pull transport + sonner; stub to markers.
jest.mock("./mobile-fleet-permission-actions", () => ({
  MobileFleetPermissionActions: () => <div data-testid="mobile-fleet-permission" />,
}))
jest.mock("./mobile-fleet-reply", () => ({
  MobileFleetReply: () => <div data-testid="mobile-fleet-reply" />,
}))
const focusMock = jest.fn()
jest.mock("@/lib/fleet/fleet-remote-actions", () => ({
  fleetRemoteFocusTerminal: (...a: unknown[]) => focusMock(...a),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

beforeEach(() => focusMock.mockReset().mockResolvedValue(undefined))

function session(over: Partial<FleetSession> = {}): FleetSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    status: "working",
    cwd: null,
    projectName: null,
    lastPrompt: null,
    activity: null,
    permissionMode: null,
    model: null,
    terminal: null,
    transcriptPath: null,
    agentPid: null,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: false,
      openTranscript: false,
    },
    startedAt: 0,
    lastEventAt: 0,
    toolUseCount: 0,
    turnCount: 0,
    ...over,
  }
}

describe("MobileFleetRow", () => {
  it("renders project name, model chip, and a status line", () => {
    render(
      <MobileFleetRow
        session={session({
          projectName: "cognia",
          model: "claude-opus-4-8",
          activity: { toolName: "Bash", detail: "test" },
        })}
      />
    )
    expect(screen.getByText("cognia")).toBeInTheDocument()
    expect(screen.getByText("Opus")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-fleet-status")).toBeInTheDocument()
  })

  it("swaps the status line for permission actions when one is parked", () => {
    render(
      <MobileFleetRow
        session={session({
          status: "waiting-permission",
          pendingPermission: { requestId: "r", toolName: "Bash", detail: null, requestedAt: 0 },
        })}
      />
    )
    expect(screen.getByTestId("mobile-fleet-permission")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-fleet-status")).toBeNull()
  })

  it("renders an error banner when the session errored", () => {
    render(<MobileFleetRow session={session({ lastError: { kind: "tool", detail: "boom", at: 0 } })} />)
    expect(screen.getByTestId("mobile-fleet-error")).toHaveTextContent("boom")
  })

  it("renders an error banner without a trailing detail", () => {
    render(<MobileFleetRow session={session({ lastError: { kind: "turn", detail: null, at: 0 } })} />)
    const err = screen.getByTestId("mobile-fleet-error")
    expect(err).toBeInTheDocument()
    expect(err.textContent).not.toContain("·")
  })

  it("shows the prompt line and omits the model chip when absent", () => {
    render(<MobileFleetRow session={session({ lastPrompt: "fix the bug", model: null })} />)
    expect(screen.getByTestId("mobile-fleet-prompt")).toHaveTextContent("fix the bug")
    // No model chip element (only the dot / project / elapsed are present).
    expect(screen.queryByText("Opus")).toBeNull()
  })

  it.each([
    ["idle", "Idle"],
    ["plan-pending", "Plan awaiting approval on desktop"],
    ["waiting-input", "Waiting for input on desktop"],
    ["ended", "Session ended"],
    ["waiting-permission", "Waiting for permission"],
  ] as const)("labels the %s status", (status, label) => {
    render(<MobileFleetRow session={session({ status, activity: null })} />)
    expect(screen.getByTestId("mobile-fleet-status")).toHaveTextContent(label)
  })

  it("freezes an ended row's elapsed at its end time", () => {
    render(<MobileFleetRow session={session({ status: "ended", startedAt: 1_000, endedAt: 61_000 })} />)
    expect(screen.getByText("1m00s")).toBeInTheDocument()
  })

  it("shows a focus-terminal button only when the capability is set", () => {
    const { rerender } = render(<MobileFleetRow session={session()} />)
    expect(screen.queryByTestId("mobile-fleet-focus")).toBeNull()

    rerender(
      <MobileFleetRow
        session={session({
          capabilities: {
            approvePermission: false,
            sendMessage: false,
            focusTerminal: true,
            openTranscript: false,
          },
        })}
      />
    )
    fireEvent.click(screen.getByTestId("mobile-fleet-focus"))
    expect(focusMock).toHaveBeenCalledWith("claude-code", "s1")
  })

  it("shows the reply control only for a live send-capable session", () => {
    const sendCaps = {
      approvePermission: false,
      sendMessage: true,
      focusTerminal: false,
      openTranscript: false,
    }
    const { rerender } = render(
      <MobileFleetRow session={session({ agent: "opencode", capabilities: sendCaps })} />
    )
    expect(screen.getByTestId("mobile-fleet-reply")).toBeInTheDocument()

    // Ended session → no reply affordance.
    rerender(
      <MobileFleetRow session={session({ agent: "opencode", status: "ended", capabilities: sendCaps })} />
    )
    expect(screen.queryByTestId("mobile-fleet-reply")).toBeNull()
  })
})
