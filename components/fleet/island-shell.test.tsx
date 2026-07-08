/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import {
  IslandShell,
  ISLAND_COLLAPSED_WIDTH,
  ISLAND_EXPANDED_WIDTH,
  ISLAND_PEEK_HEIGHT,
  ISLAND_PILL_HEIGHT,
  ISLAND_SHRINK_SETTLE_MS,
  ISLAND_TUCK_DELAY_MS,
} from "./island-shell"
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
  it("renders the empty pill collapsed and untucked", () => {
    render(<IslandShell />)
    const shell = screen.getByTestId("island-shell")
    expect(shell.getAttribute("data-expanded")).toBe("false")
    expect(shell.getAttribute("data-tucked")).toBe("false")
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
    const zone = screen.getByTestId("island-hover-zone")
    const shell = screen.getByTestId("island-shell")
    fireEvent.mouseEnter(zone)
    expect(shell.getAttribute("data-expanded")).toBe("true")
    expect(shell.style.width).toBe(`${ISLAND_EXPANDED_WIDTH}px`)
    const rows = screen.getByTestId("island-list").querySelectorAll("[data-status]")
    expect(rows[0].getAttribute("data-status")).toBe("waiting-permission")
    fireEvent.mouseLeave(zone)
    expect(shell.getAttribute("data-expanded")).toBe("false")
    expect(screen.queryByTestId("island-list")).toBeNull()
  })

  it("toggles via the pill button (click affordance for touch/no-hover)", () => {
    streamState.snapshot = { generatedAt: 1, sessions: [session()] }
    render(<IslandShell />)
    fireEvent.click(screen.getByTestId("island-pill"))
    expect(screen.getByTestId("island-shell").getAttribute("data-expanded")).toBe("true")
    fireEvent.click(screen.getByTestId("island-pill"))
    expect(screen.getByTestId("island-shell").getAttribute("data-expanded")).toBe("false")
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
    fireEvent.mouseLeave(screen.getByTestId("island-hover-zone"))
    expect(shell.getAttribute("data-expanded")).toBe("true")
  })

  it("reports its measured size to the window layer on shape changes", () => {
    streamState.snapshot = { generatedAt: 1, sessions: [session()] }
    render(<IslandShell />)
    expect(resizeMock).toHaveBeenCalledWith(ISLAND_COLLAPSED_WIDTH, expect.any(Number))
    fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
    expect(resizeMock).toHaveBeenLastCalledWith(ISLAND_EXPANDED_WIDTH, expect.any(Number))
  })

  it("defers the window shrink until the collapse animation settles", () => {
    jest.useFakeTimers()
    streamState.snapshot = { generatedAt: 1, sessions: [session()] }
    render(<IslandShell />)
    const zone = screen.getByTestId("island-hover-zone")
    fireEvent.mouseEnter(zone)
    expect(resizeMock).toHaveBeenLastCalledWith(ISLAND_EXPANDED_WIDTH, expect.any(Number))
    resizeMock.mockClear()

    // Collapse: the window must NOT snap down while the card is still wide —
    // that clips the animating content at the window edge.
    fireEvent.mouseLeave(zone)
    expect(resizeMock).not.toHaveBeenCalledWith(ISLAND_COLLAPSED_WIDTH, expect.any(Number))
    act(() => {
      jest.advanceTimersByTime(ISLAND_SHRINK_SETTLE_MS)
    })
    expect(resizeMock).toHaveBeenLastCalledWith(ISLAND_COLLAPSED_WIDTH, expect.any(Number))
    jest.useRealTimers()
  })

  describe("auto-tuck (Dock-style hide when idle)", () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })
    afterEach(() => {
      jest.useRealTimers()
    })

    it("tucks up after the grace delay when there are no sessions", () => {
      render(<IslandShell />)
      const shell = screen.getByTestId("island-shell")
      expect(shell.getAttribute("data-tucked")).toBe("false")
      act(() => {
        jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS)
      })
      expect(shell.getAttribute("data-tucked")).toBe("true")
      // Slides up leaving only the peek sliver inside the window.
      expect(shell.style.transform).toBe(`translateY(${ISLAND_PEEK_HEIGHT - ISLAND_PILL_HEIGHT}px)`)
    })

    it("tucks even while sessions merely work or idle (nothing needs the user)", () => {
      streamState.snapshot = {
        generatedAt: 1,
        sessions: [session(), session({ sessionId: "s2", status: "idle" })],
      }
      render(<IslandShell />)
      act(() => {
        jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS)
      })
      expect(screen.getByTestId("island-shell").getAttribute("data-tucked")).toBe("true")
    })

    it("never tucks while a session needs attention", () => {
      streamState.snapshot = {
        generatedAt: 1,
        sessions: [session({ status: "waiting-input" })],
      }
      render(<IslandShell />)
      act(() => {
        jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS * 3)
      })
      expect(screen.getByTestId("island-shell").getAttribute("data-tucked")).toBe("false")
    })

    it("hover cancels a pending tuck and slides a tucked island back out", () => {
      render(<IslandShell />)
      const zone = screen.getByTestId("island-hover-zone")
      const shell = screen.getByTestId("island-shell")

      // Pending tuck cancelled by hover.
      act(() => {
        jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS - 1)
      })
      fireEvent.mouseEnter(zone)
      act(() => {
        jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS * 2)
      })
      expect(shell.getAttribute("data-tucked")).toBe("false")

      // Leave → tucks again; re-enter the (still pill-sized) window → untucks.
      fireEvent.mouseLeave(zone)
      act(() => {
        jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS)
      })
      expect(shell.getAttribute("data-tucked")).toBe("true")
      fireEvent.mouseEnter(zone)
      expect(shell.getAttribute("data-tucked")).toBe("false")
      expect(shell.style.transform).toBe("translateY(0px)")
    })

    it("a session starting to wait pops a tucked island back out", () => {
      streamState.snapshot = { generatedAt: 1, sessions: [session()] }
      const { rerender } = render(<IslandShell />)
      act(() => {
        jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS)
      })
      expect(screen.getByTestId("island-shell").getAttribute("data-tucked")).toBe("true")

      streamState.snapshot = {
        generatedAt: 2,
        sessions: [session({ status: "waiting-input" })],
      }
      rerender(<IslandShell />)
      expect(screen.getByTestId("island-shell").getAttribute("data-tucked")).toBe("false")
    })

    it("keeps the window at the pill footprint while tucked (hover target)", () => {
      render(<IslandShell />)
      act(() => {
        jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS)
      })
      // No resize below the pill height was requested — the transparent window
      // area is the re-show hover target.
      for (const call of resizeMock.mock.calls) {
        expect(call[1]).toBeGreaterThanOrEqual(ISLAND_PILL_HEIGHT)
      }
    })
  })
})
