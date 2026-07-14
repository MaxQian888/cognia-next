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
  useFormatter: () => ({ dateTime: () => "TIME" }),
}))

// The expanded row detail reads OS reduced-motion; pin it for determinism.
jest.mock("motion/react", () => ({ useReducedMotion: () => true }))

const resizeMock = jest.fn()
const setTuckedMock = jest.fn()
jest.mock("@/lib/tauri/fleet", () => ({
  islandResize: (...args: unknown[]) => resizeMock(...args),
  islandSetTucked: (...args: unknown[]) => setTuckedMock(...args),
  fleetPermissionRespond: jest.fn(),
  fleetQuestionRespond: jest.fn(),
}))

// Off-Tauri by default (jsdom); the geometry-event test flips it on.
const tauriState = { on: false }
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauriState.on,
}))

const listenMock = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
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
    toolUseCount: 0,
    turnCount: 0,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  streamState.snapshot = { sessions: [], generatedAt: 0 }
  tauriState.on = false
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

  it("force-expands while any session has an answerable AskUserQuestion", () => {
    streamState.snapshot = {
      generatedAt: 1,
      sessions: [
        session({
          status: "waiting-input",
          pendingQuestions: [{ question: "Pick?", options: ["A", "B"], multiSelect: false }],
          pendingQuestionRequest: { requestId: "q-1", requestedAt: Date.now() },
        }),
      ],
    }
    render(<IslandShell />)
    const shell = screen.getByTestId("island-shell")
    expect(shell.getAttribute("data-expanded")).toBe("true")
    // Mouse-leave can't collapse it while the question is still answerable.
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

  it("expands one row's detail panel independently", () => {
    streamState.snapshot = {
      generatedAt: 1,
      sessions: [session(), session({ sessionId: "s2" })],
    }
    render(<IslandShell />)
    fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
    expect(screen.queryByTestId("session-detail")).toBeNull()

    const toggles = screen.getAllByTestId("session-detail-toggle")
    fireEvent.click(toggles[0])
    // Only the toggled row reveals its detail.
    expect(screen.getAllByTestId("session-detail")).toHaveLength(1)
  })

  it("uses a red attention ring for a parked permission and amber for an input wait", () => {
    streamState.snapshot = {
      generatedAt: 1,
      sessions: [
        session({
          status: "waiting-permission",
          pendingPermission: { requestId: "r", toolName: "Bash", detail: null, requestedAt: 0 },
        }),
      ],
    }
    const { rerender } = render(<IslandShell />)
    const ring = screen.getByTestId("island-attention-ring")
    expect(ring).toHaveAttribute("data-severity", "permission")
    expect(ring.className).toContain("island-attention-ring--danger")

    streamState.snapshot = { generatedAt: 2, sessions: [session({ status: "waiting-input" })] }
    rerender(<IslandShell />)
    const ring2 = screen.getByTestId("island-attention-ring")
    expect(ring2).toHaveAttribute("data-severity", "input")
    expect(ring2.className).toContain("island-attention-ring")
    expect(ring2.className).not.toContain("island-attention-ring--danger")
  })

  it("re-reports a grown window size when a row detail expands (no clip)", () => {
    streamState.snapshot = { generatedAt: 1, sessions: [session()] }
    // jsdom does no layout, so fake the card growing once the detail mounts.
    const orig = Element.prototype.getBoundingClientRect
    const spy = jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element
    ) {
      const base = orig.call(this) as DOMRect
      const grown = this.querySelector('[data-testid="session-detail"]') ? 240 : 80
      return { ...base, height: grown } as DOMRect
    })
    try {
      render(<IslandShell />)
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
      resizeMock.mockClear()
      fireEvent.click(screen.getByTestId("session-detail-toggle"))
      // Grow-now: the taller card is reported before paint so it isn't clipped.
      expect(resizeMock).toHaveBeenCalled()
      const lastHeight = resizeMock.mock.calls.at(-1)?.[1] as number
      expect(lastHeight).toBeGreaterThanOrEqual(240)
    } finally {
      spy.mockRestore()
    }
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

    it("mirrors tuck transitions to the window click-through toggle", () => {
      render(<IslandShell />)
      // Mounted untucked → the window must be interactive.
      expect(setTuckedMock).toHaveBeenLastCalledWith(false)
      act(() => {
        jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS)
      })
      expect(setTuckedMock).toHaveBeenLastCalledWith(true)
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
      expect(setTuckedMock).toHaveBeenLastCalledWith(false)
    })

    it("clears a stale pin when the fleet empties so the island can tuck", () => {
      streamState.snapshot = { generatedAt: 1, sessions: [session()] }
      const { rerender } = render(<IslandShell />)
      fireEvent.click(screen.getByTestId("island-pill"))
      expect(screen.getByTestId("island-shell").getAttribute("data-expanded")).toBe("true")
      // Pinned open blocks the tuck while sessions exist…
      act(() => {
        jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS * 2)
      })
      expect(screen.getByTestId("island-shell").getAttribute("data-tucked")).toBe("false")

      // …but once the fleet empties the pin resets and the island tucks away.
      streamState.snapshot = { generatedAt: 2, sessions: [] }
      rerender(<IslandShell />)
      act(() => {
        jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS)
      })
      expect(screen.getByTestId("island-shell").getAttribute("data-tucked")).toBe("true")
    })
  })

  describe("attention ring", () => {
    it("breathes an attention ring while a session needs the user", () => {
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
      expect(screen.getByTestId("island-attention-ring")).toBeInTheDocument()
    })

    it("has no ring when every session is merely working or idle", () => {
      streamState.snapshot = { generatedAt: 1, sessions: [session()] }
      render(<IslandShell />)
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
      expect(screen.queryByTestId("island-attention-ring")).toBeNull()
    })
  })

  describe("status legend (expanded triage)", () => {
    it("shows a per-status breakdown for two or more sessions", () => {
      streamState.snapshot = {
        generatedAt: 1,
        sessions: [
          session({ sessionId: "a", status: "working" }),
          session({ sessionId: "b", status: "waiting-input" }),
          session({ sessionId: "c", status: "idle" }),
        ],
      }
      render(<IslandShell />)
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
      const legend = screen.getByTestId("island-legend")
      expect(legend).toBeInTheDocument()
      expect(screen.getByTestId("island-legend-needsYou").textContent).toContain(
        'legend.needsYou:{"count":1}'
      )
      expect(screen.getByTestId("island-legend-working").textContent).toContain(
        'legend.working:{"count":1}'
      )
      expect(screen.getByTestId("island-legend-idle").textContent).toContain(
        'legend.idle:{"count":1}'
      )
    })

    it("omits the legend for a single-session fleet", () => {
      streamState.snapshot = { generatedAt: 1, sessions: [session()] }
      render(<IslandShell />)
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
      expect(screen.queryByTestId("island-legend")).toBeNull()
    })
  })

  describe("notch inset (top safe area)", () => {
    it("pads the card below the notch when island_resize returns an inset", async () => {
      resizeMock.mockReturnValue(Promise.resolve(37))
      streamState.snapshot = { generatedAt: 1, sessions: [session()] }
      render(<IslandShell />)
      // Flush the resize promise the layout effect chained applyInset onto.
      await act(async () => {})
      expect(screen.getByTestId("island-clip").style.marginTop).toBe("37px")
      expect(screen.getByTestId("island-hover-zone").style.minHeight).toBe(
        `${ISLAND_PILL_HEIGHT + 37}px`
      )
    })

    it("keeps a zero margin on displays without a notch", async () => {
      resizeMock.mockReturnValue(Promise.resolve(0))
      render(<IslandShell />)
      await act(async () => {})
      expect(screen.getByTestId("island-clip").style.marginTop).toBe("0px")
      expect(screen.getByTestId("island-hover-zone").style.minHeight).toBe(
        `${ISLAND_PILL_HEIGHT}px`
      )
    })

    it("normalizes a non-numeric resize answer (older backend / web) to zero", async () => {
      resizeMock.mockReturnValue(Promise.resolve(undefined))
      render(<IslandShell />)
      await act(async () => {})
      expect(screen.getByTestId("island-clip").style.marginTop).toBe("0px")
    })

    it("re-pads when Rust pushes fleet://island-geometry (monitor change)", async () => {
      tauriState.on = true
      const handlers = new Map<string, (e: { payload?: unknown }) => void>()
      const unlisten = jest.fn()
      listenMock.mockImplementation(
        async (event: string, cb: (e: { payload?: unknown }) => void) => {
          handlers.set(event, cb)
          return unlisten
        }
      )
      const { unmount } = render(<IslandShell />)
      await act(async () => {})
      expect(listenMock).toHaveBeenCalledWith("fleet://island-geometry", expect.any(Function))
      const handler = handlers.get("fleet://island-geometry")

      act(() => handler?.({ payload: { topInset: 21 } }))
      expect(screen.getByTestId("island-clip").style.marginTop).toBe("21px")

      // Monitor without a notch → back to zero.
      act(() => handler?.({ payload: { topInset: 0 } }))
      expect(screen.getByTestId("island-clip").style.marginTop).toBe("0px")

      unmount()
      expect(unlisten).toHaveBeenCalled()
    })
  })

  describe("native hover events (fleet://island-hover)", () => {
    it("untucks a click-through island on a Rust hover push and re-tucks on leave", async () => {
      jest.useFakeTimers()
      tauriState.on = true
      const handlers = new Map<string, (e: { payload?: unknown }) => void>()
      listenMock.mockImplementation(
        async (event: string, cb: (e: { payload?: unknown }) => void) => {
          handlers.set(event, cb)
          return jest.fn()
        }
      )
      try {
        render(<IslandShell />)
        await act(async () => {})
        expect(listenMock).toHaveBeenCalledWith("fleet://island-hover", expect.any(Function))
        const hover = handlers.get("fleet://island-hover")

        act(() => {
          jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS)
        })
        const shell = screen.getByTestId("island-shell")
        expect(shell.getAttribute("data-tucked")).toBe("true")

        // While tucked the window ignores cursor events (no DOM mouseenter) —
        // the Rust cursor poll is the only reveal path.
        act(() => hover?.({ payload: { hovering: true } }))
        expect(shell.getAttribute("data-tucked")).toBe("false")

        // Cursor leaves → tuck timer re-arms and the island hides again.
        act(() => hover?.({ payload: { hovering: false } }))
        act(() => {
          jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS)
        })
        expect(shell.getAttribute("data-tucked")).toBe("true")
      } finally {
        jest.useRealTimers()
      }
    })

    it("a trailing hovering:false heals a hover stuck by a missed mouseleave", async () => {
      jest.useFakeTimers()
      tauriState.on = true
      const handlers = new Map<string, (e: { payload?: unknown }) => void>()
      listenMock.mockImplementation(
        async (event: string, cb: (e: { payload?: unknown }) => void) => {
          handlers.set(event, cb)
          return jest.fn()
        }
      )
      try {
        streamState.snapshot = { generatedAt: 1, sessions: [session()] }
        render(<IslandShell />)
        await act(async () => {})
        const shell = screen.getByTestId("island-shell")

        // DOM hover expands, but the matching mouseleave never fires (the OS
        // window resized under the cursor) — previously pinned it expanded.
        fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
        expect(shell.getAttribute("data-expanded")).toBe("true")

        const hover = handlers.get("fleet://island-hover")
        act(() => hover?.({ payload: { hovering: false } }))
        expect(shell.getAttribute("data-expanded")).toBe("false")
        act(() => {
          jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS)
        })
        expect(shell.getAttribute("data-tucked")).toBe("true")
      } finally {
        jest.useRealTimers()
      }
    })
  })
})
