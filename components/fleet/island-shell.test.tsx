/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { IslandShell, ISLAND_COLLAPSED_WIDTH, ISLAND_EXPANDED_WIDTH } from "./island-shell"
import type { FleetSession } from "@/lib/fleet/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const resizeMock = jest.fn()
jest.mock("@/lib/tauri/fleet", () => ({
  islandResize: (...args: unknown[]) => resizeMock(...args),
  fleetPermissionRespond: jest.fn(),
}))

const streamState: {
  snapshot: { sessions: FleetSession[]; generatedAt: number }
  available: boolean
} = {
  snapshot: { sessions: [], generatedAt: 0 },
  available: true,
}
jest.mock("@/hooks/fleet/use-fleet-stream", () => ({
  useFleetStream: () => streamState,
}))

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    status: "working",
    cwd: null,
    projectName: "proj",
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
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  streamState.snapshot = { sessions: [], generatedAt: 0 }
})

describe("IslandShell", () => {
  it("renders the empty pill collapsed", () => {
    render(<IslandShell />)
    const shell = screen.getByTestId("island-shell")
    expect(shell.getAttribute("data-expanded")).toBe("false")
    expect(screen.getByTestId("island-summary")).toHaveTextContent("empty")
    expect(shell.style.width).toBe(`${ISLAND_COLLAPSED_WIDTH}px`)
  })

  it("summarizes counts and waiting sessions", () => {
    streamState.snapshot = {
      generatedAt: 1,
      sessions: [session(), session({ sessionId: "s2", status: "waiting-input" })],
    }
    render(<IslandShell />)
    expect(screen.getByTestId("island-summary")).toHaveTextContent(
      'summaryWaiting:{"count":2,"waiting":1}'
    )
  })

  it("expands on hover, showing rows sorted by attention, and collapses on leave", () => {
    streamState.snapshot = {
      generatedAt: 1,
      sessions: [
        session({ sessionId: "calm", status: "idle" }),
        session({ sessionId: "hot", status: "waiting-permission" }),
      ],
    }
    render(<IslandShell />)
    const shell = screen.getByTestId("island-shell")
    fireEvent.mouseEnter(shell)
    expect(shell.getAttribute("data-expanded")).toBe("true")
    expect(shell.style.width).toBe(`${ISLAND_EXPANDED_WIDTH}px`)
    const rows = screen.getByTestId("island-list").querySelectorAll("[data-status]")
    expect(rows[0].getAttribute("data-status")).toBe("waiting-permission")
    fireEvent.mouseLeave(shell)
    expect(shell.getAttribute("data-expanded")).toBe("false")
    expect(screen.queryByTestId("island-list")).toBeNull()
  })

  it("toggles via the pill button (click affordance for touch/no-hover)", () => {
    streamState.snapshot = { generatedAt: 1, sessions: [session()] }
    render(<IslandShell />)
    fireEvent.click(screen.getByTestId("island-pill"))
    expect(screen.getByTestId("island-shell").getAttribute("data-expanded")).toBe("true")
  })

  it("force-expands while any session has a pending permission", () => {
    streamState.snapshot = {
      generatedAt: 1,
      sessions: [
        session({
          status: "waiting-permission",
          pendingPermission: {
            requestId: "r",
            toolName: "Bash",
            detail: null,
            requestedAt: Date.now(),
          },
        }),
      ],
    }
    render(<IslandShell />)
    const shell = screen.getByTestId("island-shell")
    expect(shell.getAttribute("data-expanded")).toBe("true")
    // Mouse-leave can't collapse it while the permission is still pending.
    fireEvent.mouseLeave(shell)
    expect(shell.getAttribute("data-expanded")).toBe("true")
  })

  it("reports its measured size to the window layer on shape changes", () => {
    streamState.snapshot = { generatedAt: 1, sessions: [session()] }
    render(<IslandShell />)
    expect(resizeMock).toHaveBeenCalledWith(ISLAND_COLLAPSED_WIDTH, expect.any(Number))
    fireEvent.mouseEnter(screen.getByTestId("island-shell"))
    expect(resizeMock).toHaveBeenLastCalledWith(ISLAND_EXPANDED_WIDTH, expect.any(Number))
  })
})
