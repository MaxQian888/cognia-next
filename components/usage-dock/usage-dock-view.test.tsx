/**
 * The rail's interaction contract. Hover comes from Rust rather than the DOM,
 * so most of these tests drive the injected hover handler directly, which is
 * exactly how the real window receives it.
 */

const handlers: {
  state?: (s: unknown) => void
  hover?: (h: boolean) => void
  geometry?: (g: unknown) => void
} = {}
const revealMock = jest.fn(async () => {})
const resizeMock = jest.fn(async () => {})
const clickThroughMock = jest.fn(async () => {})
const snapMock = jest.fn(async () => "left")
const requestStateMock = jest.fn(async () => true)
const openFullMock = jest.fn(async () => true)

jest.mock("@/lib/usage-dock/client", () => ({
  onUsageDockState: async (h: (s: unknown) => void) => {
    handlers.state = h
    return () => {}
  },
  onUsageDockHover: async (h: (v: boolean) => void) => {
    handlers.hover = h
    return () => {}
  },
  onUsageDockGeometry: async (h: (g: unknown) => void) => {
    handlers.geometry = h
    return () => {}
  },
  revealUsageDock: () => revealMock(),
  resizeUsageDock: (...a: unknown[]) => resizeMock(...(a as [])),
  setUsageDockClickThrough: (...a: unknown[]) => clickThroughMock(...(a as [])),
  snapUsageDock: (...a: unknown[]) => snapMock(...(a as [])),
  requestUsageDockState: () => requestStateMock(),
  requestUsageDockOpenFull: () => openFullMock(),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { UsageDockView } from "./usage-dock-view"
import { buildUsageGlance, type UsageGlanceSnapshotV1 } from "@/lib/usage/usage-glance"
import { DEFAULT_USAGE_DOCK_PREFERENCES } from "@/lib/usage-dock/types"

const leader = (id: string, cost: number, over = {}) => ({
  id,
  knownCostUsd: cost,
  tokens: 10,
  turns: 2,
  unpricedTurns: 0,
  ...over,
})

function glance(over: Partial<UsageGlanceSnapshotV1> = {}): UsageGlanceSnapshotV1 {
  return {
    ...buildUsageGlance({
      rows: [],
      query: { period: "today", scope: "cognia", metric: "spend" },
      now: 0,
    }),
    ...over,
  }
}

const twoProviders = glance({
  knownCostUsd: 10,
  turns: 4,
  topProviders: [leader("anthropic", 7), leader("openai", 3)],
})

async function pushState(over: Record<string, unknown> = {}) {
  await act(async () => {
    handlers.state?.({
      glance: twoProviders,
      preferences: DEFAULT_USAGE_DOCK_PREFERENCES,
      ...over,
    })
  })
}

beforeEach(() => {
  revealMock.mockClear()
  resizeMock.mockClear()
  clickThroughMock.mockClear()
  snapMock.mockClear()
  requestStateMock.mockClear()
  openFullMock.mockClear()
})

describe("UsageDockView", () => {
  it("reveals itself after first paint, which is what Windows needs", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(revealMock).toHaveBeenCalled())
  })

  it("asks the main window to seed it", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(requestStateMock).toHaveBeenCalled())
  })

  it("shows a loading line before any state arrives", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(screen.getByTestId("usage-dock-empty")).toBeInTheDocument())
  })

  it("collapses to the busiest provider until hovered", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(handlers.state).toBeDefined())
    await pushState()
    expect(screen.getByTestId("usage-dock-row-anthropic")).toBeInTheDocument()
    expect(screen.queryByTestId("usage-dock-row-openai")).not.toBeInTheDocument()
  })

  it("expands to every provider on the native hover event", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(handlers.hover).toBeDefined())
    await pushState()
    await act(async () => handlers.hover?.(true))
    expect(screen.getByTestId("usage-dock-row-openai")).toBeInTheDocument()
  })

  it("honours a pinned preferred provider when collapsed", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(handlers.state).toBeDefined())
    await pushState({
      preferences: { ...DEFAULT_USAGE_DOCK_PREFERENCES, preferredProviderId: "openai" },
    })
    expect(screen.getByTestId("usage-dock-row-openai")).toBeInTheDocument()
    expect(screen.queryByTestId("usage-dock-row-anthropic")).not.toBeInTheDocument()
  })

  it("starts expanded when the user asked it to", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(handlers.state).toBeDefined())
    await pushState({
      preferences: { ...DEFAULT_USAGE_DOCK_PREFERENCES, startExpanded: true },
    })
    expect(screen.getByTestId("usage-dock-row-openai")).toBeInTheDocument()
  })

  it("is click-through while collapsed and interactive while expanded", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(clickThroughMock).toHaveBeenCalledWith(true))
    await pushState()
    await act(async () => handlers.hover?.(true))
    await waitFor(() => expect(clickThroughMock).toHaveBeenCalledWith(false))
  })

  it("pins a row's detail on click and releases it on a second click", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(handlers.hover).toBeDefined())
    await pushState()
    await act(async () => handlers.hover?.(true))
    const row = screen.getByTestId("usage-dock-row-openai")
    await userEvent.click(row)
    expect(row).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(row)
    expect(row).toHaveAttribute("aria-pressed", "false")
  })

  it("releases a pinned row on Escape", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(handlers.hover).toBeDefined())
    await pushState()
    await act(async () => handlers.hover?.(true))
    await userEvent.click(screen.getByTestId("usage-dock-row-openai"))
    await userEvent.keyboard("{Escape}")
    expect(screen.getByTestId("usage-dock-row-openai")).toHaveAttribute("aria-pressed", "false")
  })

  it("reorients when Rust reports a new edge", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(handlers.geometry).toBeDefined())
    await pushState()
    await act(async () =>
      handlers.geometry?.({ edge: "top", areaWidth: 100, areaHeight: 100, scale: 1 })
    )
    expect(screen.getByTestId("usage-dock-rail")).toHaveAttribute("data-edge", "top")
  })

  it("snaps a drag using the GLOBAL point, not one relative to itself", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(handlers.state).toBeDefined())
    await pushState()
    // `screenX/Y` is the global point Rust's snap math needs. `clientX/Y`
    // would be relative to the very window being moved, which snaps to the
    // wrong edge on every monitor but the primary.
    const handle = screen.getByTestId("usage-dock-handle")
    fireEvent.mouseUp(handle, { screenX: 12, screenY: 400 })
    await waitFor(() => expect(snapMock).toHaveBeenCalledWith(12, 400))
  })

  it("routes the total through the main window rather than navigating itself", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(handlers.hover).toBeDefined())
    await pushState()
    await act(async () => handlers.hover?.(true))
    await userEvent.click(screen.getByTestId("usage-dock-total"))
    expect(openFullMock).toHaveBeenCalled()
  })

  it("says the day is empty rather than drawing a zero gauge", async () => {
    render(<UsageDockView />)
    await waitFor(() => expect(handlers.state).toBeDefined())
    await act(async () => {
      handlers.state?.({ glance: glance(), preferences: DEFAULT_USAGE_DOCK_PREFERENCES })
    })
    expect(screen.getByTestId("usage-dock-empty")).toBeInTheDocument()
  })
})
