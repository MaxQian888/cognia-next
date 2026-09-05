/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({ dateTime: () => "TIME" }),
}))
jest.mock("motion/react", () => ({ useReducedMotion: () => true }))
jest.mock("@/hooks/fleet/use-now-ticker", () => ({ useNowTicker: () => 10_000 }))

const resizeMock = jest.fn()
const setTuckedMock = jest.fn()
jest.mock("@/lib/tauri/fleet", () => ({
  islandResize: (...args: unknown[]) => resizeMock(...args),
  islandSetTucked: (...args: unknown[]) => setTuckedMock(...args),
  fleetPermissionRespond: jest.fn(),
  fleetQuestionRespond: jest.fn(),
  fleetQuestionReject: jest.fn(),
  fleetOpencodeSendMessage: jest.fn(),
}))

const tauriState = { on: false }
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauriState.on }))

const listenMock = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listenMock(...args) }))

const dispatchMock = jest.fn(async () => true)
const islandState: { current: IslandState } = { current: EMPTY_ISLAND_STATE }
jest.mock("@/hooks/island/use-island-state", () => ({
  useIslandState: () => islandState.current,
}))
jest.mock("@/hooks/island/use-island-actions", () => ({
  IDLE_ACTION_STATUS: { pending: false, error: null },
  useIslandActions: () => ({
    statusOf: () => ({ pending: false, error: null }),
    dispatch: dispatchMock,
  }),
}))
const detailSlot = { rowId: null as string | null, detail: null, error: null }
const detailArgs = jest.fn()
jest.mock("@/hooks/island/use-island-detail", () => ({
  useIslandDetail: (rowId: string | null, revision: number) => {
    detailArgs(rowId, revision)
    return detailSlot
  },
}))

import {
  IslandShell,
  ISLAND_COLLAPSED_WIDTH,
  ISLAND_COMPACT_THRESHOLD,
  ISLAND_EXPANDED_WIDTH,
  ISLAND_PEEK_HEIGHT,
  ISLAND_PILL_HEIGHT,
  ISLAND_TUCK_DELAY_MS,
} from "./island-shell"
import {
  EMPTY_ISLAND_STATE,
  NO_ISLAND_CAPABILITIES,
  type IslandRowProjection,
  type IslandState,
} from "@/lib/island/types"

function row(over: Partial<IslandRowProjection> = {}): IslandRowProjection {
  return {
    id: "external:opencode:oc",
    source: "external",
    owner: { kind: "external", agent: "opencode", sessionId: "oc" },
    agent: "opencode",
    status: "working",
    priority: 2,
    title: "proj",
    summary: "Bash",
    startedAt: 0,
    updatedAt: 5_000,
    capabilities: { ...NO_ISLAND_CAPABILITIES },
    stale: false,
    ...over,
  }
}

function setState(rows: IslandRowProjection[], over: Partial<IslandState> = {}) {
  islandState.current = {
    epoch: 1,
    revision: 3,
    generatedAt: 1,
    activeCount: rows.filter((r) => r.status === "working" || r.status === "blocked").length,
    attentionCount: rows.filter((r) => r.status === "blocked").length,
    detailVisibility: "click-to-reveal",
    rows,
    ...over,
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  resizeMock.mockReset().mockResolvedValue({ topInset: 0, notchWidth: 0, fullscreen: false })
  setTuckedMock.mockReset()
  dispatchMock.mockClear()
  detailArgs.mockClear()
  listenMock.mockReset().mockResolvedValue(() => {})
  tauriState.on = false
  detailSlot.rowId = null
  islandState.current = EMPTY_ISLAND_STATE
})
afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("presentations", () => {
  it("is compact by default and names the highest-priority task", () => {
    setState([row({ title: "alpha", summary: "Bash" }), row({ id: "b", title: "beta" })])
    render(<IslandShell />)
    const shell = screen.getByTestId("island-shell")
    expect(shell).toHaveAttribute("data-presentation", "compact")
    expect(shell).toHaveAttribute("data-expanded", "false")
    expect(screen.getByTestId("island-compact-title").textContent).toBe("alpha")
    expect(screen.getByTestId("island-compact-summary").textContent).toBe("Bash")
    expect(screen.getByTestId("island-compact-more").textContent).toContain("more")
    expect(shell.style.width).toBe(`${ISLAND_COLLAPSED_WIDTH}px`)
  })

  it("falls back to a count when there is nothing to name", () => {
    render(<IslandShell />)
    expect(screen.getByTestId("island-summary").textContent).toBe("empty")
  })

  it("expands on hover and lists every row", () => {
    setState([row({ id: "a", title: "alpha" }), row({ id: "b", title: "beta" })])
    render(<IslandShell />)
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
    })
    const shell = screen.getByTestId("island-shell")
    expect(shell).toHaveAttribute("data-presentation", "expanded")
    expect(shell.style.width).toBe(`${ISLAND_EXPANDED_WIDTH}px`)
    expect(screen.getByTestId("island-task-row-a")).toBeInTheDocument()
    expect(screen.getByTestId("island-task-row-b")).toBeInTheDocument()
  })

  it("goes minimal after the tuck delay and shows only a count", () => {
    setState([row({ status: "working" })])
    render(<IslandShell />)
    act(() => {
      jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS + 1)
    })
    const shell = screen.getByTestId("island-shell")
    expect(shell).toHaveAttribute("data-presentation", "minimal")
    expect(shell.style.transform).toBe(`translateY(${ISLAND_PEEK_HEIGHT - ISLAND_PILL_HEIGHT}px)`)
    const minimal = screen.getByTestId("island-minimal")
    expect(minimal.textContent).toBe("1")
    // The tuck leaves the card's BOTTOM `ISLAND_PEEK_HEIGHT` px on screen, so
    // the count must be anchored there; at the top it sat above the clip.
    expect(minimal.className).toContain("bottom-0")
    expect(minimal.style.height).toBe(`${ISLAND_PEEK_HEIGHT}px`)
    expect(setTuckedMock).toHaveBeenCalledWith(true)
  })

  it("paints glass without a housing and no notch column at all", async () => {
    setState([row({ status: "working" })])
    render(<IslandShell />)
    await act(async () => {})
    const surface = screen.getByTestId("island-surface")
    expect(surface.className).toContain("backdrop-blur-xl")
    expect(surface.style.top).toBe("0px")
    expect(screen.queryByTestId("island-notch-fill")).toBeNull()
  })

  it("paints only a housing-wide black column in the notch strip", async () => {
    setState([row({ status: "working" })])
    resizeMock.mockResolvedValue({ topInset: 37, notchWidth: 200, fullscreen: false })
    render(<IslandShell />)
    await act(async () => {})
    const shell = screen.getByTestId("island-shell")
    // The card box is transparent: the menu bar beside the housing shows.
    expect(shell.className).not.toContain("bg-black")
    expect(shell.style.paddingTop).toBe("37px")
    // The surface starts below the housing and is its true black, not glass.
    const surface = screen.getByTestId("island-surface")
    expect(surface.style.top).toBe("37px")
    expect(surface.className.split(" ")).toContain("bg-black")
    expect(surface.className).not.toContain("backdrop-blur-xl")
    // The column is exactly the housing, joined one pixel into the surface.
    const column = screen.getByTestId("island-notch-fill")
    expect(column.style.width).toBe("200px")
    expect(column.style.height).toBe("38px")
    expect(column.className).toContain("left-1/2")
  })

  it("paints the whole strip when the OS reported no housing width", async () => {
    setState([row({ status: "working" })])
    resizeMock.mockResolvedValue({ topInset: 37, notchWidth: 0, fullscreen: false })
    render(<IslandShell />)
    await act(async () => {})
    expect(screen.getByTestId("island-notch-fill").style.width).toBe(`${ISLAND_COLLAPSED_WIDTH}px`)
  })

  it("never paints a column wider than the card", async () => {
    setState([row({ status: "working" })])
    resizeMock.mockResolvedValue({ topInset: 37, notchWidth: 9_000, fullscreen: false })
    render(<IslandShell />)
    await act(async () => {})
    expect(screen.getByTestId("island-notch-fill").style.width).toBe(`${ISLAND_COLLAPSED_WIDTH}px`)
  })

  it("switches rows to their compact shape past the threshold", () => {
    setState(Array.from({ length: ISLAND_COMPACT_THRESHOLD }, (_, i) => row({ id: `r${i}` })))
    render(<IslandShell />)
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
    })
    expect(screen.getByTestId("island-task-row-r0")).toHaveAttribute("data-compact", "true")
  })
})

describe("attention", () => {
  const blocked = row({
    status: "blocked",
    statusKey: "awaitingPermission",
    summary: "",
    waitingSince: 4_000,
    permission: { requestId: "p1", toolName: "Bash", requestedAt: 9_995 },
    capabilities: { ...NO_ISLAND_CAPABILITIES, permissionDecision: true },
  })

  it("force-expands for an answerable item and never tucks it away", () => {
    setState([blocked])
    render(<IslandShell />)
    expect(screen.getByTestId("island-shell")).toHaveAttribute("data-expanded", "true")
    act(() => {
      jest.advanceTimersByTime(ISLAND_TUCK_DELAY_MS * 3)
    })
    expect(screen.getByTestId("island-shell")).toHaveAttribute("data-tucked", "false")
    expect(screen.getByTestId("island-permission-actions")).toBeInTheDocument()
  })

  it("rings red for a permission and amber otherwise", () => {
    setState([blocked])
    const { unmount } = render(<IslandShell />)
    expect(screen.getByTestId("island-attention-ring")).toHaveAttribute(
      "data-severity",
      "permission"
    )
    unmount()

    setState([row({ status: "blocked", statusKey: "awaitingApproval", summary: "" })])
    render(<IslandShell />)
    expect(screen.getByTestId("island-attention-ring")).toHaveAttribute("data-severity", "input")
  })

  it("does not force-expand for a plain progress update", () => {
    setState([row({ status: "working" })])
    render(<IslandShell />)
    expect(screen.getByTestId("island-shell")).toHaveAttribute("data-expanded", "false")
  })

  it("announces the waiting count politely", () => {
    setState([blocked])
    render(<IslandShell />)
    const announce = screen.getByTestId("island-announce")
    expect(announce).toHaveAttribute("aria-live", "polite")
    expect(announce.textContent).toContain("announceWaiting")
  })
})

describe("detail policy", () => {
  it("requests nothing until a row is pinned, under click-to-reveal", () => {
    setState([row({ capabilities: { ...NO_ISLAND_CAPABILITIES, detail: true } })])
    render(<IslandShell />)
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
    })
    expect(detailArgs).toHaveBeenLastCalledWith(null, 3)

    act(() => {
      fireEvent.click(screen.getByTestId("island-detail-toggle"))
    })
    expect(detailArgs).toHaveBeenLastCalledWith("external:opencode:oc", 3)
  })

  it("reveals the top row on hover under the hover policy", () => {
    setState([row({ capabilities: { ...NO_ISLAND_CAPABILITIES, detail: true } })], {
      detailVisibility: "hover",
    })
    render(<IslandShell />)
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
    })
    expect(detailArgs).toHaveBeenLastCalledWith("external:opencode:oc", 3)
  })

  it("asks for nothing at all under summary-only, even when pinned", () => {
    setState([row({ capabilities: { ...NO_ISLAND_CAPABILITIES, detail: true } })], {
      detailVisibility: "summary-only",
    })
    render(<IslandShell />)
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
      fireEvent.click(screen.getByTestId("island-detail-toggle"))
    })
    expect(detailArgs).toHaveBeenLastCalledWith(null, 3)
  })

  it("drops the pin when its row leaves the projection", () => {
    setState([row({ capabilities: { ...NO_ISLAND_CAPABILITIES, detail: true } })])
    const { rerender } = render(<IslandShell />)
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
      fireEvent.click(screen.getByTestId("island-detail-toggle"))
    })
    expect(detailArgs).toHaveBeenLastCalledWith("external:opencode:oc", 3)

    setState([row({ id: "other", capabilities: { ...NO_ISLAND_CAPABILITIES, detail: true } })])
    act(() => {
      rerender(<IslandShell />)
    })
    expect(detailArgs).toHaveBeenLastCalledWith(null, 3)
  })
})

describe("keyboard", () => {
  it("collapses and unpins on Escape", () => {
    setState([row({ capabilities: { ...NO_ISLAND_CAPABILITIES, detail: true } })])
    render(<IslandShell />)
    act(() => {
      fireEvent.click(screen.getByTestId("island-pill"))
    })
    expect(screen.getByTestId("island-shell")).toHaveAttribute("data-expanded", "true")
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" })
    })
    expect(screen.getByTestId("island-shell")).toHaveAttribute("data-expanded", "false")
  })

  it("exposes the pill as an expandable control and the list as a labelled list", () => {
    setState([row()])
    render(<IslandShell />)
    expect(screen.getByTestId("island-pill")).toHaveAttribute("aria-expanded", "false")
    act(() => {
      fireEvent.click(screen.getByTestId("island-pill"))
    })
    expect(screen.getByTestId("island-pill")).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("island-list")).toHaveAttribute("aria-label", "listLabel")
  })
})

describe("window reporting", () => {
  it("reports its size to Rust so the frameless window hugs the content", () => {
    setState([row()])
    render(<IslandShell />)
    expect(resizeMock).toHaveBeenCalledWith(ISLAND_COLLAPSED_WIDTH, ISLAND_PILL_HEIGHT)
  })

  it("grows the window immediately when it expands", () => {
    setState([row()])
    render(<IslandShell />)
    resizeMock.mockClear()
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId("island-hover-zone"))
    })
    expect(resizeMock.mock.calls.at(-1)?.[0]).toBe(ISLAND_EXPANDED_WIDTH)
  })
})
