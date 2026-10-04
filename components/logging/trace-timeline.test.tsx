/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { makeSpan } from "@/lib/observability/fixtures"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

jest.mock("next-intl", () => {
  // Key-echo translator (with `has`, which the enum-label hook asks before
  // translating) plus an Intl-backed formatter — what next-intl's
  // `useFormatter` does, in "en"/UTC (next-intl itself is ESM-only and cannot
  // be `requireActual`-ed here) — so units and currency render as in the app.
  const translator = (namespace: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${namespace}.${key}:${JSON.stringify(vars)}` : `${namespace}.${key}`
  return {
    useTranslations: (namespace: string) =>
      Object.assign(translator(namespace), { has: () => false }),
    useFormatter: () => ({
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat("en", options).format(value),
      dateTime: (value: number | Date, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options }).format(value),
    }),
  }
})

jest.mock("@/hooks/logging/use-theme-colors", () => ({
  useThemeColors: () => ({
    destructive: "#f00",
    chart1: "#111",
    chart2: "#222",
    chart3: "#333",
    chart4: "#444",
    chart5: "#555",
  }),
}))

import { TraceTimeline } from "./trace-timeline"

function spans(): AgentTraceSpan[] {
  return [
    makeSpan({
      spanId: "root",
      startTime: 1_000,
      durationMs: 1_000,
      operationName: "invoke_agent",
      agentName: "planner",
      events: [{ name: "tool_call", at: 1_200 }],
    }),
    makeSpan({
      spanId: "tool-a",
      parentSpanId: "root",
      startTime: 1_200,
      durationMs: 100,
      operationName: "execute_tool",
      toolName: "Bash",
    }),
    makeSpan({
      spanId: "tool-b",
      parentSpanId: "root",
      startTime: 1_500,
      durationMs: 50,
      operationName: "execute_tool",
      toolName: "Read",
      errorType: "ToolError",
    }),
  ]
}

function renderTimeline(over: Partial<React.ComponentProps<typeof TraceTimeline>> = {}) {
  const props = {
    spans: spans(),
    scale: "duration" as const,
    onScaleChange: jest.fn(),
    grouping: "operation" as const,
    onGroupingChange: jest.fn(),
    window: null,
    onWindowChange: jest.fn(),
    onSelectSpan: jest.fn(),
    ...over,
  }
  return { props, ...render(<TraceTimeline {...props} />) }
}

/** jsdom gives every element a zero-size rect; the brush needs a real one. */
function stubTrackWidth(width = 1000): void {
  const track = screen.getByTestId("trace-timeline-brush")
  jest.spyOn(track, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: width,
    bottom: 16,
    width,
    height: 16,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  Object.assign(track, {
    setPointerCapture: jest.fn(),
    releasePointerCapture: jest.fn(),
  })
}

describe("TraceTimeline", () => {
  it("renders a loading state before the spans arrive", () => {
    renderTimeline({ loading: true })
    expect(screen.getByTestId("trace-timeline-loading")).toBeInTheDocument()
  })

  it("renders an empty state for a trace with no spans", () => {
    renderTimeline({ spans: [] })
    expect(screen.getByTestId("trace-timeline-empty")).toHaveTextContent(
      "logging.workspace.traces.timeline.empty"
    )
  })

  it("explains an empty state caused by the zoom window", () => {
    renderTimeline({ window: { since: 9_000, until: 9_100 } })
    expect(screen.getByTestId("trace-timeline-empty")).toHaveTextContent(
      "logging.workspace.traces.timeline.emptyWindow"
    )
  })

  it("draws one lane per operation with a block per span", () => {
    renderTimeline()
    expect(screen.getByTestId("timeline-lane-invoke_agent")).toBeInTheDocument()
    expect(screen.getByTestId("timeline-lane-execute_tool")).toBeInTheDocument()
    expect(screen.getByTestId("timeline-block-root")).toBeInTheDocument()
    expect(screen.getByTestId("timeline-block-tool-a")).toBeInTheDocument()
    expect(screen.getByTestId("timeline-block-tool-b")).toBeInTheDocument()
  })

  it("positions blocks proportionally under the duration scale", () => {
    renderTimeline()
    expect(screen.getByTestId("timeline-block-tool-a")).toHaveStyle({ left: "20%", width: "10%" })
  })

  it("selects a span when a block is clicked", () => {
    const { props } = renderTimeline()
    fireEvent.click(screen.getByTestId("timeline-block-tool-a"))
    expect(props.onSelectSpan).toHaveBeenCalledWith("tool-a")
  })

  it("marks the selected block", () => {
    renderTimeline({ selectedSpanId: "tool-b" })
    expect(screen.getByTestId("timeline-block-tool-b")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("timeline-block-root")).not.toHaveAttribute("aria-current")
  })

  it("dims non-matching blocks rather than hiding them", () => {
    renderTimeline({ highlightQuery: "bash" })
    expect(screen.getByTestId("timeline-block-root")).toHaveClass("opacity-25")
    expect(screen.getByTestId("timeline-block-tool-a")).not.toHaveClass("opacity-25")
    // Still present — a filtered trace keeps its shape.
    expect(screen.getByTestId("timeline-block-tool-b")).toBeInTheDocument()
  })

  it("reports scale and grouping changes upward", async () => {
    const user = userEvent.setup()
    const { props } = renderTimeline()
    fireEvent.click(screen.getByTestId("timeline-scale-sequence"))
    expect(props.onScaleChange).toHaveBeenCalledWith("sequence")

    await user.click(screen.getByLabelText("logging.workspace.traces.timeline.groupingLabel"))
    await user.click(screen.getByRole("option", { name: /groupings.surface/ }))
    expect(props.onGroupingChange).toHaveBeenCalledWith("surface")
  })

  it("plots mid-span events as markers on the axis", () => {
    renderTimeline()
    expect(screen.getAllByTestId("trace-timeline-marker")).toHaveLength(1)
  })

  it("converts a horizontal drag into a zoom window", () => {
    const { props } = renderTimeline()
    stubTrackWidth(1000)
    const track = screen.getByTestId("trace-timeline-brush")
    fireEvent.pointerDown(track, { button: 0, clientX: 200, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 600, pointerId: 1 })
    expect(screen.getByTestId("trace-timeline-selection")).toBeInTheDocument()
    fireEvent.pointerUp(track, { clientX: 600, pointerId: 1 })
    expect(props.onWindowChange).toHaveBeenCalledWith({ since: 1_200, until: 1_600 })
  })

  it("ignores a drag too small to be deliberate", () => {
    const { props } = renderTimeline()
    stubTrackWidth(1000)
    const track = screen.getByTestId("trace-timeline-brush")
    fireEvent.pointerDown(track, { button: 0, clientX: 500, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 503, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 503, pointerId: 1 })
    expect(props.onWindowChange).not.toHaveBeenCalled()
  })

  it("resets the zoom on double-click and from the chip", () => {
    const { props } = renderTimeline({ window: { since: 1_100, until: 1_600 } })
    fireEvent.doubleClick(screen.getByTestId("trace-timeline-brush"))
    expect(props.onWindowChange).toHaveBeenCalledWith(null)

    fireEvent.click(screen.getByTestId("timeline-reset-zoom"))
    expect(props.onWindowChange).toHaveBeenCalledWith(null)
  })

  it("hides the reset chip when showing the whole trace", () => {
    renderTimeline()
    expect(screen.queryByTestId("timeline-reset-zoom")).not.toBeInTheDocument()
  })

  it("summarizes the visible window in the toolbar", () => {
    renderTimeline()
    expect(screen.getByTestId("timeline-total-spans")).toHaveTextContent('"count":3')
  })

  it("does not start a zoom gesture from a block", () => {
    const { props } = renderTimeline()
    stubTrackWidth(1000)
    fireEvent.pointerDown(screen.getByTestId("timeline-block-tool-a"), {
      button: 0,
      clientX: 200,
      pointerId: 1,
    })
    fireEvent.pointerUp(screen.getByTestId("trace-timeline-brush"), { clientX: 900, pointerId: 1 })
    expect(props.onWindowChange).not.toHaveBeenCalled()
  })

  it("mounts exactly one hover card, only while a block is hovered", () => {
    renderTimeline()
    expect(screen.queryByTestId("timeline-hover-card")).not.toBeInTheDocument()

    fireEvent.pointerEnter(screen.getByTestId("timeline-block-tool-a"))
    expect(screen.getAllByTestId("timeline-hover-card")).toHaveLength(1)
    expect(screen.getByTestId("timeline-hover-card")).toHaveTextContent("Bash")

    fireEvent.pointerLeave(screen.getByTestId("timeline-block-tool-a"))
    expect(screen.queryByTestId("timeline-hover-card")).not.toBeInTheDocument()
  })

  it("shows the hover card on keyboard focus too", () => {
    renderTimeline()
    fireEvent.focus(screen.getByTestId("timeline-block-root"))
    expect(screen.getByTestId("timeline-hover-card")).toHaveTextContent("planner")
    fireEvent.blur(screen.getByTestId("timeline-block-root"))
    expect(screen.queryByTestId("timeline-hover-card")).not.toBeInTheDocument()
  })

  it("gives each lane a single tab stop under a roving tabindex", () => {
    renderTimeline()
    // Two tool blocks share a lane; only one is tab-reachable.
    const toolBlocks = [
      screen.getByTestId("timeline-block-tool-a"),
      screen.getByTestId("timeline-block-tool-b"),
    ]
    expect(toolBlocks.filter((b) => b.getAttribute("tabindex") === "0")).toHaveLength(1)
    expect(screen.getByTestId("timeline-block-root")).toHaveAttribute("tabindex", "0")
  })

  it("makes the selected block the lane's tab stop", () => {
    renderTimeline({ selectedSpanId: "tool-b" })
    expect(screen.getByTestId("timeline-block-tool-b")).toHaveAttribute("tabindex", "0")
    expect(screen.getByTestId("timeline-block-tool-a")).toHaveAttribute("tabindex", "-1")
  })

  it("moves along a lane with the arrow keys", () => {
    renderTimeline()
    const first = screen.getByTestId("timeline-block-tool-a")
    fireEvent.focus(first)
    fireEvent.keyDown(first, { key: "ArrowRight" })
    expect(screen.getByTestId("timeline-block-tool-b")).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId("timeline-block-tool-b"), { key: "ArrowLeft" })
    expect(screen.getByTestId("timeline-block-tool-a")).toHaveFocus()
  })

  it("jumps to the ends of a lane with Home and End", () => {
    renderTimeline()
    const first = screen.getByTestId("timeline-block-tool-a")
    fireEvent.focus(first)
    fireEvent.keyDown(first, { key: "End" })
    expect(screen.getByTestId("timeline-block-tool-b")).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId("timeline-block-tool-b"), { key: "Home" })
    expect(screen.getByTestId("timeline-block-tool-a")).toHaveFocus()
  })

  it("moves between lanes with the up and down arrows", () => {
    renderTimeline()
    const root = screen.getByTestId("timeline-block-root")
    fireEvent.focus(root)
    fireEvent.keyDown(root, { key: "ArrowDown" })
    expect(screen.getByTestId("timeline-block-tool-a")).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId("timeline-block-tool-a"), { key: "ArrowUp" })
    expect(root).toHaveFocus()
  })

  it("stays put at the first lane instead of wrapping", () => {
    renderTimeline()
    const root = screen.getByTestId("timeline-block-root")
    // Real DOM focus: `fireEvent.focus` only dispatches the event.
    root.focus()
    fireEvent.keyDown(root, { key: "ArrowUp" })
    expect(root).toHaveFocus()
  })

  it("stays put at the last lane instead of wrapping", () => {
    renderTimeline()
    const last = screen.getByTestId("timeline-block-tool-a")
    last.focus()
    fireEvent.keyDown(last, { key: "ArrowDown" })
    expect(last).toHaveFocus()
  })

  it("renders inert blocks when the host supplies no select handler", () => {
    renderTimeline({ onSelectSpan: undefined })
    expect(screen.getByTestId("timeline-block-root")).toBeDisabled()
  })
})

describe("TraceTimeline — header, zoom and search", () => {
  it("hosts the pane header: leading identity and trailing actions, in every state", () => {
    renderTimeline({
      loading: true,
      leading: <span data-testid="lead">trace-id</span>,
      actions: <button data-testid="act">export</button>,
    })
    expect(screen.getByTestId("lead")).toBeInTheDocument()
    expect(screen.getByTestId("act")).toBeInTheDocument()
    expect(screen.getByTestId("trace-timeline-loading")).toBeInTheDocument()
  })

  it("counts the window against the whole trace when zoomed — one count, not two", () => {
    renderTimeline({ window: { since: 1_150, until: 1_350 } })
    expect(screen.getByTestId("timeline-total-spans")).toHaveTextContent("spansOf")
    expect(screen.getByTestId("timeline-total-spans")).toHaveTextContent('"total":3')
  })

  it("zooms with + / - / 0 from anywhere in the strip", () => {
    const { props } = renderTimeline()
    const block = screen.getByTestId("timeline-block-root")
    fireEvent.keyDown(block, { key: "+" })
    expect(props.onWindowChange).toHaveBeenLastCalledWith({ since: 1_250, until: 1_750 })
    fireEvent.keyDown(block, { key: "0" })
    expect(props.onWindowChange).toHaveBeenLastCalledWith(null)
  })

  it("zooms out by doubling the window, back to null at the full trace", () => {
    const { props } = renderTimeline({ window: { since: 1_250, until: 1_750 } })
    fireEvent.keyDown(screen.getByTestId("trace-timeline"), { key: "-" })
    expect(props.onWindowChange).toHaveBeenLastCalledWith(null)
  })

  it("offers zoom buttons, with zoom-out disabled at the full trace", () => {
    const { props } = renderTimeline()
    expect(screen.getByTestId("timeline-zoom-out")).toBeDisabled()
    fireEvent.click(screen.getByTestId("timeline-zoom-in"))
    expect(props.onWindowChange).toHaveBeenCalledWith({ since: 1_250, until: 1_750 })
  })

  it("starts a zoom drag on a lane's empty space, not only on the brush", () => {
    const { props } = renderTimeline()
    stubTrackWidth(1000)
    const lane = screen.getByTestId("timeline-lane-execute_tool")
    fireEvent.pointerDown(lane, { button: 0, clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(lane, { clientX: 500, pointerId: 1 })
    fireEvent.pointerUp(lane, { clientX: 500, pointerId: 1 })
    expect(props.onWindowChange).toHaveBeenCalledWith({ since: 1_100, until: 1_500 })
  })

  it("ignores a press in the lane-label gutter", () => {
    const { props } = renderTimeline()
    stubTrackWidth(1000)
    // The brush rect starts at 0; a press left of it is off the time axis.
    const lane = screen.getByTestId("timeline-lane-execute_tool")
    fireEvent.pointerDown(lane, { button: 0, clientX: -50, pointerId: 1 })
    fireEvent.pointerUp(lane, { clientX: 400, pointerId: 1 })
    expect(props.onWindowChange).not.toHaveBeenCalled()
  })

  it("highlights with the list's matcher — a trace id lights every block", () => {
    const all = spans().map((span) => ({ ...span, traceId: "abc123" }))
    renderTimeline({ spans: all, highlightQuery: "ABC123" })
    for (const id of ["root", "tool-a", "tool-b"]) {
      expect(screen.getByTestId(`timeline-block-${id}`)).not.toHaveClass("opacity-25")
    }
  })

  it("matches a block's own surface, as the list matches a trace's", () => {
    const mixed = spans()
    mixed[1] = { ...mixed[1], surface: "mcp" }
    renderTimeline({ spans: mixed, highlightQuery: "mcp" })
    expect(screen.getByTestId("timeline-block-tool-a")).not.toHaveClass("opacity-25")
    expect(screen.getByTestId("timeline-block-root")).toHaveClass("opacity-25")
  })

  it("folds to its toolbar and caps the lane area so it scrolls", () => {
    const onCollapsedChange = jest.fn()
    const { rerender, props } = renderTimeline({ onCollapsedChange })
    expect(screen.getByTestId("trace-timeline-lanes")).toHaveClass("max-h-40", "overflow-y-auto")
    fireEvent.click(screen.getByTestId("timeline-collapse"))
    expect(onCollapsedChange).toHaveBeenCalledWith(true)
    rerender(<TraceTimeline {...props} collapsed />)
    expect(screen.queryByTestId("trace-timeline-lanes")).not.toBeInTheDocument()
    expect(screen.getByTestId("timeline-collapse")).toHaveAttribute("aria-expanded", "false")
  })

  it("labels ruler ticks with app-locale durations", () => {
    renderTimeline()
    expect(screen.getByTestId("trace-timeline-ruler")).toHaveTextContent("1s")
  })

  it("keeps the raw lane id as the lane label's title", () => {
    renderTimeline()
    expect(screen.getAllByTitle("execute_tool").length).toBeGreaterThan(0)
  })
})
