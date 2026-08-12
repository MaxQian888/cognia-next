/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import {
  IslandShell,
  ISLAND_COLLAPSED_WIDTH,
  ISLAND_COMPACT_THRESHOLD,
  ISLAND_EXPANDED_WIDTH,
  ISLAND_HIDDEN_HEIGHT,
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
      approvePermission: true,
      sendMessage: false,
      focusTerminal: false,
      openTranscript: false,
      interrupt: false,
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
  // `clearAllMocks` wipes call records but NOT implementations, so a test that
  // sets a geometry (notably `fullscreen: true`, which withdraws the island
  // entirely) would otherwise leak that regime into every later test.
  resizeMock.mockReturnValue(Promise.resolve({ topInset: 0, fullscreen: false }))
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
    // The list deliberately stays mounted so the collapse has an exit
    // animation (the card's height eases down and clips it). It is hidden from
    // assistive tech and made inert instead of being torn out of the DOM.
    const body = screen.getByTestId("island-body")
    expect(body.getAttribute("aria-hidden")).toBe("true")
    expect(body.className).toContain("opacity-0")
    expect(body.className).toContain("pointer-events-none")
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
          session({ sessionId: "d", status: "detached" }),
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
      expect(screen.getByTestId("island-legend-detached").textContent).toContain(
        'legend.detached:{"count":1}'
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
    it("hugs the display's top edge and pads only its content below the notch", async () => {
      resizeMock.mockReturnValue(Promise.resolve({ topInset: 37, fullscreen: false }))
      streamState.snapshot = { generatedAt: 1, sessions: [session()] }
      render(<IslandShell />)
      // Flush the resize promise the layout effect chained applyGeometry onto.
      await act(async () => {})
      // The clip container never offsets the card: the card's body must reach
      // the true top edge so it merges with the camera housing.
      expect(screen.getByTestId("island-clip").style.marginTop).toBe("")
      const shell = screen.getByTestId("island-shell")
      expect(shell.style.paddingTop).toBe("37px")
      // Card box = content (pill) + the notch strip it covers.
      expect(shell.style.height).toBe(`${ISLAND_PILL_HEIGHT + 37}px`)
      // Flush against the screen edge → no floating-card rounding up there.
      // (jsdom serializes a zero length without its unit.)
      expect(shell.style.borderTopLeftRadius).toMatch(/^0(px)?$/)
      expect(shell.style.borderTopRightRadius).toMatch(/^0(px)?$/)
      expect(screen.getByTestId("island-hover-zone").style.minHeight).toBe(
        `${ISLAND_PILL_HEIGHT + 37}px`
      )
      // Rust is still told the CONTENT size — it grows the window by the inset.
      expect(resizeMock).toHaveBeenLastCalledWith(ISLAND_COLLAPSED_WIDTH, ISLAND_PILL_HEIGHT)
    })

    it("keeps the full pill rounding and no padding on displays without a notch", async () => {
      resizeMock.mockReturnValue(Promise.resolve({ topInset: 0, fullscreen: false }))
      render(<IslandShell />)
      await act(async () => {})
      const shell = screen.getByTestId("island-shell")
      expect(shell.style.paddingTop).toBe("0px")
      expect(shell.style.height).toBe(`${ISLAND_PILL_HEIGHT}px`)
      expect(shell.style.borderTopLeftRadius).toBe("")
      expect(shell.style.borderTopRightRadius).toBe("")
      expect(screen.getByTestId("island-hover-zone").style.minHeight).toBe(
        `${ISLAND_PILL_HEIGHT}px`
      )
    })

    it("normalizes a non-numeric resize answer (older backend / web) to zero", async () => {
      resizeMock.mockReturnValue(Promise.resolve(undefined))
      render(<IslandShell />)
      await act(async () => {})
      expect(screen.getByTestId("island-shell").style.paddingTop).toBe("0px")
    })

    it("tucks to a bare peek sliver at the top edge, notch strip included", async () => {
      jest.useFakeTimers()
      try {
        resizeMock.mockReturnValue(Promise.resolve({ topInset: 37, fullscreen: false }))
        render(<IslandShell />)
        await act(async () => {})
        act(() => {
          jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS)
        })
        const shell = screen.getByTestId("island-shell")
        expect(shell.getAttribute("data-tucked")).toBe("true")
        // The whole card — notch strip and all — slides up, so the leftover
        // sliver is PEEK px, not PEEK + a notch-height black band.
        expect(shell.style.transform).toBe(
          `translateY(${ISLAND_PEEK_HEIGHT - (ISLAND_PILL_HEIGHT + 37)}px)`
        )
      } finally {
        jest.useRealTimers()
      }
    })

    it("fills the notch strip opaque so the menu bar can't show through", async () => {
      resizeMock.mockReturnValue(Promise.resolve({ topInset: 37, fullscreen: false }))
      render(<IslandShell />)
      await act(async () => {})
      const fill = screen.getByTestId("island-notch-fill")
      expect(fill.style.height).toBe("37px")
      expect(fill.className).toContain("bg-black")
    })

    it("paints no notch strip on a display that has none", async () => {
      resizeMock.mockReturnValue(Promise.resolve({ topInset: 0, fullscreen: false }))
      render(<IslandShell />)
      await act(async () => {})
      expect(screen.queryByTestId("island-notch-fill")).toBeNull()
    })

    it("offsets the attention ring below the notch", async () => {
      resizeMock.mockReturnValue(Promise.resolve({ topInset: 37, fullscreen: false }))
      streamState.snapshot = {
        generatedAt: 1,
        sessions: [session({ status: "waiting-input" })],
      }
      render(<IslandShell />)
      await act(async () => {})
      expect(screen.getByTestId("island-attention-ring").style.top).toBe("37px")
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
      expect(screen.getByTestId("island-shell").style.paddingTop).toBe("21px")

      // Monitor without a notch → back to zero, full rounding restored.
      act(() => handler?.({ payload: { topInset: 0 } }))
      expect(screen.getByTestId("island-shell").style.paddingTop).toBe("0px")
      expect(screen.getByTestId("island-shell").style.borderTopLeftRadius).toBe("")

      unmount()
      expect(unlisten).toHaveBeenCalled()
    })
  })

  describe("full-screen Space withdrawal", () => {
    /** Render and let the resize round-trip deliver the geometry. */
    async function renderWithGeometry(geometry: { topInset: number; fullscreen: boolean }) {
      resizeMock.mockReturnValue(Promise.resolve(geometry))
      render(<IslandShell />)
      await act(async () => {})
    }

    it("paints nothing at all while a full-screen app owns the display", async () => {
      // A merely working session doesn't need the user — on a normal Space this
      // would still leave the tucked 6px sliver, which is exactly the black bar
      // that shows up over a full-screen video.
      streamState.snapshot = { generatedAt: 1, sessions: [session({ status: "working" })] }
      await renderWithGeometry({ topInset: 0, fullscreen: true })

      expect(screen.getByTestId("island-hidden")).toBeInTheDocument()
      expect(screen.queryByTestId("island-shell")).toBeNull()
      expect(screen.queryByTestId("island-pill")).toBeNull()
      expect(screen.queryByTestId("island-hover-zone")).toBeNull()
    })

    it("makes the withdrawn window click-through and shrinks it to a sliver", async () => {
      jest.useFakeTimers()
      try {
        streamState.snapshot = { generatedAt: 1, sessions: [session({ status: "idle" })] }
        await renderWithGeometry({ topInset: 0, fullscreen: true })

        // Click-through is the load-bearing half and must not wait: a
        // full-height transparent strip pinned over a full-screen app's toolbar
        // swallows its clicks for as long as it lingers.
        expect(setTuckedMock).toHaveBeenCalledWith(true)

        // The window shrink itself is deferred (grow-now / shrink-later), so an
        // in-flight CSS transition is never clipped at the window edge.
        await act(async () => {
          jest.advanceTimersByTime(ISLAND_SHRINK_SETTLE_MS)
        })
        const heights = resizeMock.mock.calls.map((c: unknown[]) => c[1])
        expect(heights).toContain(ISLAND_HIDDEN_HEIGHT)
      } finally {
        jest.useRealTimers()
      }
    })

    it("materializes for a pending permission even while full-screen", async () => {
      streamState.snapshot = {
        generatedAt: 1,
        sessions: [
          session({
            status: "waiting-permission",
            pendingPermission: {
              requestId: "r1",
              toolName: "Bash",
              detail: null,
              requestedAt: 0,
            },
          }),
        ],
      }
      await renderWithGeometry({ topInset: 0, fullscreen: true })

      expect(screen.queryByTestId("island-hidden")).toBeNull()
      expect(screen.getByTestId("island-shell").getAttribute("data-expanded")).toBe("true")
    })

    it("materializes for a session waiting on input while full-screen", async () => {
      streamState.snapshot = {
        generatedAt: 1,
        sessions: [session({ status: "waiting-input" })],
      }
      await renderWithGeometry({ topInset: 0, fullscreen: true })
      expect(screen.queryByTestId("island-hidden")).toBeNull()
      expect(screen.getByTestId("island-shell")).toBeInTheDocument()
    })

    it("keeps a user's pin honored when the display goes full-screen", async () => {
      streamState.snapshot = { generatedAt: 1, sessions: [session({ status: "working" })] }
      await renderWithGeometry({ topInset: 0, fullscreen: false })

      // Pin it on a normal Space...
      fireEvent.click(screen.getByTestId("island-pill"))
      expect(screen.getByTestId("island-shell").getAttribute("data-expanded")).toBe("true")

      // ...then a full-screen app takes the display. The pin is an explicit
      // user choice and outranks the withdrawal rule.
      tauriState.on = true
      await act(async () => {})
      expect(screen.queryByTestId("island-hidden")).toBeNull()
    })

    it("returns to the normal tucked sliver once full-screen ends", async () => {
      tauriState.on = true
      const handlers = new Map<string, (e: { payload?: unknown }) => void>()
      listenMock.mockImplementation(
        async (event: string, cb: (e: { payload?: unknown }) => void) => {
          handlers.set(event, cb)
          return jest.fn()
        }
      )
      streamState.snapshot = { generatedAt: 1, sessions: [session({ status: "working" })] }
      await renderWithGeometry({ topInset: 0, fullscreen: true })
      expect(screen.getByTestId("island-hidden")).toBeInTheDocument()

      // Rust's watch loop notices the Space switch and pushes the new regime.
      act(() => handlers.get("fleet://island-geometry")?.({ payload: { fullscreen: false } }))
      expect(screen.queryByTestId("island-hidden")).toBeNull()
      expect(screen.getByTestId("island-shell")).toBeInTheDocument()
    })
  })

  describe("open/close animation", () => {
    /** jsdom reports 0 for every measurement; stub the content box instead. */
    function stubContentHeight(px: number) {
      jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        height: px,
        width: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: px,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect)
    }

    afterEach(() => jest.restoreAllMocks())

    it("animates height alongside width instead of jumping", () => {
      streamState.snapshot = { generatedAt: 1, sessions: [session()] }
      stubContentHeight(180)
      render(<IslandShell />)
      const shell = screen.getByTestId("island-shell")

      // Height must be a transitioned property — the old shell animated only
      // transform and width, so expanding slid sideways while the content
      // popped in at full height in a single frame.
      expect(shell.className).toContain("transition-[transform,width,height]")

      expect(shell.style.height).toBe(`${ISLAND_PILL_HEIGHT}px`)
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
      expect(shell.style.height).toBe("180px")
      fireEvent.mouseLeave(screen.getByTestId("island-hover-zone"))
      expect(shell.style.height).toBe(`${ISLAND_PILL_HEIGHT}px`)
    })

    it("never lets the collapsed card fall below the pill height", () => {
      streamState.snapshot = { generatedAt: 1, sessions: [session()] }
      // A content box shorter than the pill (mid-teardown measurement).
      stubContentHeight(4)
      render(<IslandShell />)
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
      expect(screen.getByTestId("island-shell").style.height).toBe(`${ISLAND_PILL_HEIGHT}px`)
    })

    it("stops swallowing clicks during the deferred window shrink", async () => {
      jest.useFakeTimers()
      try {
        streamState.snapshot = { generatedAt: 1, sessions: [session()] }
        render(<IslandShell />)
        const zone = screen.getByTestId("island-hover-zone")
        fireEvent.mouseEnter(zone)
        setTuckedMock.mockClear()

        // Collapsing shrinks the card immediately but the OS window keeps the
        // expanded footprint for the settle window. That surplus is transparent
        // yet hit-tested and sits at the top-center of the screen, so it used to
        // eat clicks aimed at whatever is behind it.
        fireEvent.mouseLeave(zone)
        expect(setTuckedMock).toHaveBeenCalledWith(true)

        await act(async () => {
          jest.advanceTimersByTime(ISLAND_SHRINK_SETTLE_MS)
        })
        // ...and interactivity comes back once the window actually shrank.
        expect(setTuckedMock).toHaveBeenLastCalledWith(false)
      } finally {
        jest.useRealTimers()
      }
    })

    it("keeps the window interactive when the shrink happens under the pointer", async () => {
      jest.useFakeTimers()
      try {
        // A session ending while the user hovers the expanded list also shrinks
        // it. Going click-through there would eat the click they are aiming.
        streamState.snapshot = {
          generatedAt: 1,
          sessions: [session({ sessionId: "a" }), session({ sessionId: "b" })],
        }
        const { rerender } = render(<IslandShell />)
        fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
        setTuckedMock.mockClear()

        streamState.snapshot = { generatedAt: 2, sessions: [session({ sessionId: "a" })] }
        rerender(<IslandShell />)
        await act(async () => {})

        expect(setTuckedMock).not.toHaveBeenCalledWith(true)
      } finally {
        jest.useRealTimers()
      }
    })
  })

  describe("compact rows past the size threshold", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => session({ sessionId: `s${i}`, status: "idle" }))

    it("keeps full rows for a small fleet", () => {
      streamState.snapshot = { generatedAt: 1, sessions: many(ISLAND_COMPACT_THRESHOLD - 1) }
      render(<IslandShell />)
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
      for (const row of screen.getByTestId("island-list").querySelectorAll("[data-compact]")) {
        expect(row.getAttribute("data-compact")).toBe("false")
      }
    })

    it("compacts every row once the fleet reaches the threshold", () => {
      streamState.snapshot = { generatedAt: 1, sessions: many(ISLAND_COMPACT_THRESHOLD) }
      render(<IslandShell />)
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
      const rows = screen.getByTestId("island-list").querySelectorAll("[data-compact]")
      expect(rows.length).toBe(ISLAND_COMPACT_THRESHOLD)
      for (const row of rows) expect(row.getAttribute("data-compact")).toBe("true")
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
