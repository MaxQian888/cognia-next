/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { IslandRow } from "./island-row"
import type { FleetSession } from "@/lib/fleet/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const focusMock = jest.fn()
const sendMock = jest.fn()
jest.mock("@/lib/tauri/fleet", () => ({
  fleetPermissionRespond: jest.fn(),
  fleetFocusTerminal: (...args: unknown[]) => focusMock(...args),
  fleetOpencodeSendMessage: (...args: unknown[]) => sendMock(...args),
}))

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    status: "working",
    cwd: "/Users/x/proj/cognia-next",
    projectName: "cognia-next",
    lastPrompt: "fix the login bug",
    activity: { toolName: "Bash", detail: "pnpm test" },
    permissionMode: "default",
    model: null,
    terminal: { app: "ghostty", label: "Ghostty" },
    transcriptPath: null,
    agentPid: 123,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: true,
      openTranscript: true,
    },
    startedAt: Date.now() - 134_000, // 2m14s ago
    lastEventAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => focusMock.mockClear())

describe("IslandRow", () => {
  it("focuses the terminal on row click when capable", () => {
    render(<IslandRow session={session()} />)
    const row = screen.getByTestId("island-row-claude-code-s1")
    expect(row.getAttribute("role")).toBe("button")
    fireEvent.click(row)
    expect(focusMock).toHaveBeenCalledWith("claude-code", "s1")
  })

  it("focuses the terminal via Enter and Space keys", () => {
    render(<IslandRow session={session()} />)
    const row = screen.getByTestId("island-row-claude-code-s1")
    fireEvent.keyDown(row, { key: "Enter" })
    expect(focusMock).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(row, { key: " " })
    expect(focusMock).toHaveBeenCalledTimes(2)
    // Other keys do nothing.
    fireEvent.keyDown(row, { key: "a" })
    expect(focusMock).toHaveBeenCalledTimes(2)
  })

  it("is not a button and never focuses when the terminal is unknown", () => {
    render(
      <IslandRow
        session={session({
          terminal: null,
          capabilities: {
            approvePermission: false,
            sendMessage: false,
            focusTerminal: false,
            openTranscript: false,
          },
        })}
      />
    )
    const row = screen.getByTestId("island-row-claude-code-s1")
    expect(row.getAttribute("role")).toBeNull()
    fireEvent.click(row)
    expect(focusMock).not.toHaveBeenCalled()
  })

  it("does not focus the terminal when clicking the permission buttons", () => {
    render(
      <IslandRow
        session={session({
          status: "waiting-permission",
          pendingPermission: {
            requestId: "r1",
            toolName: "Bash",
            detail: null,
            requestedAt: Date.now(),
          },
        })}
      />
    )
    fireEvent.click(screen.getByTestId("permission-deny"))
    // Keyboard on the controls must not bubble to the row's focus handler.
    fireEvent.keyDown(screen.getByTestId("permission-deny"), { key: "Enter" })
    expect(focusMock).not.toHaveBeenCalled()
  })

  it("renders project, agent badge, terminal badge, prompt and activity", () => {
    render(<IslandRow session={session()} />)
    expect(screen.getByText("cognia-next")).toBeInTheDocument()
    expect(screen.getByTestId("agent-badge-claude-code")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-badge")).toHaveTextContent("Ghostty")
    expect(screen.getByTestId("last-prompt")).toHaveTextContent("fix the login bug")
    expect(screen.getByTestId("status-line")).toHaveTextContent("Bash(pnpm test)")
    expect(screen.getByTestId("elapsed").textContent).toMatch(/^2m1[45]s$/)
  })

  it("falls back to the session id and hides optional chrome", () => {
    render(
      <IslandRow
        session={session({
          projectName: null,
          terminal: null,
          lastPrompt: null,
          activity: null,
          status: "idle",
        })}
      />
    )
    expect(screen.getByText("s1")).toBeInTheDocument()
    expect(screen.queryByTestId("terminal-badge")).toBeNull()
    expect(screen.queryByTestId("last-prompt")).toBeNull()
    expect(screen.getByTestId("status-line")).toHaveTextContent("status.idle")
  })

  it("shows waiting/plan/ended status lines", () => {
    for (const [status, key] of [
      ["waiting-input", "status.waitingInput"],
      ["plan-pending", "status.planPending"],
      ["ended", "status.ended"],
    ] as const) {
      const { unmount } = render(<IslandRow session={session({ status, activity: null })} />)
      expect(screen.getByTestId("status-line")).toHaveTextContent(key)
      unmount()
    }
  })

  it("renders permission actions instead of the status line when pending", () => {
    render(
      <IslandRow
        session={session({
          status: "waiting-permission",
          pendingPermission: {
            requestId: "r1",
            toolName: "Bash",
            detail: "rm -rf build",
            requestedAt: Date.now(),
          },
        })}
      />
    )
    expect(screen.getByTestId("island-permission-actions")).toBeInTheDocument()
    expect(screen.queryByTestId("status-line")).toBeNull()
  })

  it("shows a plain hint for waiting-permission without an approvable request", () => {
    render(<IslandRow session={session({ status: "waiting-permission" })} />)
    expect(screen.getByTestId("status-line")).toHaveTextContent("status.waitingPermission")
  })

  it("shows a reply affordance for OpenCode sessions that accept messages", () => {
    render(
      <IslandRow
        session={session({
          agent: "opencode",
          capabilities: {
            approvePermission: false,
            sendMessage: true,
            focusTerminal: false,
            openTranscript: false,
          },
        })}
      />
    )
    expect(screen.getByTestId("island-reply-open")).toBeInTheDocument()
  })

  it("hides the reply affordance once the session ended", () => {
    render(
      <IslandRow
        session={session({
          agent: "opencode",
          status: "ended",
          capabilities: {
            approvePermission: false,
            sendMessage: true,
            focusTerminal: false,
            openTranscript: false,
          },
        })}
      />
    )
    expect(screen.queryByTestId("island-reply-open")).toBeNull()
  })
})
