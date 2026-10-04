/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { makeSpan } from "@/lib/observability/fixtures"
import { buildWaterfall } from "@/lib/observability/trace-rollup"
import type { TraceRollupRow } from "@/lib/observability/trace-rollup"

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

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

const timelineProps = jest.fn()
jest.mock("@/components/logging/trace-timeline", () => ({
  TraceTimeline: (props: Record<string, unknown>) => {
    timelineProps(props)
    return (
      <div data-testid="stub-timeline">
        {/* The pane header lives in the timeline toolbar now. */}
        {props.leading as React.ReactNode}
        {props.actions as React.ReactNode}
        <button
          type="button"
          data-testid="stub-timeline-select"
          onClick={() => (props.onSelectSpan as (id: string) => void)("child")}
        />
        <button
          type="button"
          data-testid="stub-timeline-zoom"
          onClick={() =>
            (props.onWindowChange as (w: { since: number; until: number } | null) => void)({
              since: 1_050,
              until: 1_150,
            })
          }
        />
      </div>
    )
  },
}))

jest.mock("@/components/logging/trace-export-menu", () => ({
  TraceExportMenu: ({ traceId, spans }: { traceId: string; spans: unknown[] }) => (
    <div data-testid="stub-export" data-trace={traceId} data-spans={spans.length} />
  ),
}))

// The shared toolbar owns the range/filter/refresh/export controls; this file
// is about the channel, so it is stubbed down to the two facts the channel
// decides: which filters it hands over, and whether layout editing is offered.
const toolbarProps = jest.fn()
jest.mock("@/components/observability/observability-toolbar", () => ({
  ObservabilityToolbar: (props: Record<string, unknown>) => {
    toolbarProps(props)
    return (
      <div
        data-testid="stub-toolbar"
        data-layout-controls={String(props.showLayoutControls)}
        data-compact={String(props.compact ?? false)}
        data-dense={String(props.dense ?? false)}
        data-traces={String((props.traces as unknown[]).length)}
      />
    )
  },
}))

const dashboardProps = jest.fn()
jest.mock("@/components/observability/observability-dashboard", () => ({
  ObservabilityDashboard: (props: Record<string, unknown>) => {
    dashboardProps(props)
    return <div data-testid="stub-dashboard" data-empty={String(props.empty)} />
  },
}))

jest.mock("@/components/observability/observability-settings-sheet", () => ({
  ObservabilitySettingsSheet: ({ open }: { open: boolean }) => (
    <div data-testid="stub-settings">{open ? "open" : "closed"}</div>
  ),
}))

jest.mock("@/hooks/observability/use-observability-url-sync", () => ({
  useObservabilityUrlSync: jest.fn(),
}))
const exploreUrlSyncArgs = jest.fn()
jest.mock("@/hooks/observability/use-trace-explore-url-sync", () => ({
  useTraceExploreUrlSync: (options: unknown) => exploreUrlSyncArgs(options),
}))
jest.mock("@/hooks/observability/use-refresh-tick", () => ({
  useRefreshTick: () => ({ tick: 0, lastUpdated: null, refresh: jest.fn() }),
}))

const retryRead = jest.fn()
let observabilityData = {
  spans: [] as unknown[],
  windowSpans: [] as unknown[],
  loading: false,
  spanCount: 0,
  windowSpanCount: 0,
  truncated: false,
  error: null as Error | null,
  retry: retryRead,
}
const observabilityDataArgs = jest.fn()
jest.mock("@/hooks/observability/use-observability-data", () => ({
  useObservabilityData: (...args: unknown[]) => {
    observabilityDataArgs(...args)
    return observabilityData
  },
}))

const traceListResult = {
  traces: [] as TraceRollupRow[],
  matched: [] as TraceRollupRow[],
  all: [] as TraceRollupRow[],
  windowTotal: 0,
  matchedTotal: 0,
  pageCount: 1,
  page: 0,
  loading: false,
  pendingCount: 0,
  newestStart: null as number | null,
  selectedIndex: -1,
}
const traceListOptions = jest.fn()
jest.mock("@/hooks/logging/use-trace-list", () => ({
  useTraceList: (options: Record<string, unknown>) => {
    traceListOptions(options)
    return traceListResult
  },
}))

const retryDetail = jest.fn()
function detailOf(spans: ReturnType<typeof makeSpan>[], over: Record<string, unknown> = {}) {
  return {
    waterfall: buildWaterfall(spans),
    loading: false,
    notFound: false,
    error: null as Error | null,
    retry: retryDetail,
    ...over,
  }
}
let traceDetail = detailOf([])
jest.mock("@/hooks/observability/use-trace-detail", () => ({
  useTraceDetail: () => traceDetail,
}))

jest.mock("@/hooks/ui", () => ({
  useIsNarrow: () => false,
  useResizableLayout: () => ({ defaultLayout: undefined, onLayoutChanged: jest.fn() }),
  // `TraceSpanDetail` renders real copy buttons; the clipboard is not the
  // subject here.
  useCopy: () => ({ copied: false, isCopying: false, copy: jest.fn(async () => true) }),
}))

// The channel measures ITSELF — jsdom reports 0 for every box, so the layout
// tier is driven from here rather than from a viewport media query. Both
// measured elements (the channel and the toolbar's slot) read the same value
// here; in the browser the slot is narrower by the width of the sub-view tabs.
let containerWidth = 1400
jest.mock("@/hooks/use-element-width", () => ({
  useElementWidth: () => containerWidth,
}))

import { useObservabilityStore } from "@/stores/observability/observability-store"

import { TraceWorkspace } from "./trace-workspace"

function row(over: Partial<TraceRollupRow> = {}): TraceRollupRow {
  return {
    traceId: "trace-1",
    rootName: "invoke_agent · planner",
    startTime: 1_700_000_000_000,
    durationMs: 1_234,
    spanCount: 4,
    errorCount: 0,
    totalCostUsd: 0.02,
    surface: "chat",
    ...over,
  }
}

function renderWorkspace(over: Partial<React.ComponentProps<typeof TraceWorkspace>> = {}) {
  const props = {
    subView: "explore" as const,
    onSubViewChange: jest.fn(),
    errorsOnly: false,
    onErrorsOnlyChange: jest.fn(),
    selectedTraceId: null,
    onSelectTrace: jest.fn(),
    ...over,
  }
  return { props, ...render(<TraceWorkspace {...props} />) }
}

beforeEach(() => {
  jest.clearAllMocks()
  containerWidth = 1400
  traceDetail = detailOf([])
  observabilityData = {
    spans: [],
    windowSpans: [],
    loading: false,
    spanCount: 0,
    windowSpanCount: 0,
    truncated: false,
    error: null,
    retry: retryRead,
  }
  useObservabilityStore.setState({
    layouts: null,
    rangePreset: "1h",
    customSince: null,
    customUntil: null,
    refreshMs: 0,
    filters: {},
    editMode: false,
    thresholds: {},
    hiddenPanels: [],
    timelineScale: "duration",
    timelineGrouping: "operation",
    timelineCollapsed: false,
    timelineZoom: null,
    exploreQuery: "",
    exploreSpanId: null,
  })
  Object.assign(traceListResult, {
    traces: [],
    matched: [],
    all: [],
    windowTotal: 0,
    matchedTotal: 0,
    pageCount: 1,
    page: 0,
    loading: false,
    pendingCount: 0,
    newestStart: null,
    selectedIndex: -1,
  })
})

describe("TraceWorkspace", () => {
  it("folds the list out of the one windowed read, not a second query", () => {
    observabilityData = {
      ...observabilityData,
      spans: [makeSpan({ spanId: "a" })],
      windowSpans: [makeSpan({ spanId: "a" })],
    }
    renderWorkspace()
    expect(observabilityDataArgs).toHaveBeenCalled()
    expect(traceListOptions).toHaveBeenCalledWith(
      expect.objectContaining({ spans: observabilityData.spans, loading: false })
    )
  })

  it("says so when the window read was capped", () => {
    observabilityData = {
      ...observabilityData,
      truncated: true,
      spanCount: 20_000,
      windowSpanCount: 61_004,
    }
    Object.assign(traceListResult, { traces: [row()], windowTotal: 1, matchedTotal: 1 })
    renderWorkspace()
    expect(screen.getByTestId("trace-truncated-notice")).toHaveTextContent('"total":61004')
  })

  it("hides the truncation notice for a window that fits", () => {
    Object.assign(traceListResult, { traces: [row()], windowTotal: 1, matchedTotal: 1 })
    renderWorkspace()
    expect(screen.queryByTestId("trace-truncated-notice")).not.toBeInTheDocument()
  })

  it("shows the truncation notice on the dashboard sub-view too", () => {
    observabilityData = {
      ...observabilityData,
      truncated: true,
      spanCount: 20_000,
      windowSpanCount: 61_004,
    }
    renderWorkspace({ subView: "dashboard" })
    expect(screen.getByTestId("trace-truncated-notice")).toBeInTheDocument()
  })

  it("distinguishes an empty window from a filter that matched nothing", () => {
    renderWorkspace()
    expect(screen.getByTestId("trace-list-empty")).toHaveTextContent(
      "logging.workspace.traces.emptyTitle"
    )

    Object.assign(traceListResult, { windowTotal: 12, matchedTotal: 0 })
    renderWorkspace({ errorsOnly: true })
    expect(screen.getAllByTestId("trace-list-empty").at(-1)).toHaveTextContent(
      "logging.workspace.traces.noMatchTitle"
    )
  })

  it("renders one row per trace and marks failures", () => {
    Object.assign(traceListResult, {
      traces: [row(), row({ traceId: "trace-2", errorCount: 2, rootName: "Bash" })],
      windowTotal: 2,
      matchedTotal: 2,
    })
    renderWorkspace()
    expect(screen.getByTestId("trace-row-trace-1")).toHaveTextContent("invoke_agent · planner")
    expect(screen.getByTestId("trace-row-trace-2")).toHaveClass("border-l-destructive")
  })

  it("selects a trace", () => {
    Object.assign(traceListResult, { traces: [row()], windowTotal: 1, matchedTotal: 1 })
    const { props } = renderWorkspace()
    fireEvent.click(screen.getByTestId("trace-row-trace-1"))
    expect(props.onSelectTrace).toHaveBeenCalledWith("trace-1")
  })

  it("prompts for a selection before a trace is picked", () => {
    renderWorkspace()
    expect(screen.getByTestId("trace-waterfall-pane")).toHaveTextContent(
      "logging.workspace.traces.selectPrompt"
    )
    expect(screen.getByTestId("trace-span-detail-empty")).toBeInTheDocument()
  })

  it("renders the waterfall and defaults the detail pane to the root span", () => {
    const root = makeSpan({ traceId: "t", spanId: "root", startTime: 1_000, durationMs: 500 })
    const child = makeSpan({
      traceId: "t",
      spanId: "child",
      parentSpanId: "root",
      startTime: 1_100,
      durationMs: 100,
      operationName: "execute_tool",
      toolName: "Bash",
    })
    traceDetail = detailOf([root, child])
    renderWorkspace({ selectedTraceId: "t" })

    expect(screen.getByTestId("waterfall-row-root")).toBeInTheDocument()
    expect(screen.getByTestId("waterfall-row-child")).toBeInTheDocument()
    // Root span drives the detail pane until the user picks another.
    expect(screen.getByTestId("trace-span-detail")).toBeInTheDocument()
    expect(screen.getByTestId("waterfall-select-root")).toHaveAttribute("aria-current", "true")
  })

  it("feeds the timeline the trace's raw spans", () => {
    const root = makeSpan({ traceId: "t", spanId: "root", startTime: 1_000, durationMs: 500 })
    const child = makeSpan({
      traceId: "t",
      spanId: "child",
      parentSpanId: "root",
      startTime: 1_100,
      durationMs: 100,
    })
    traceDetail = detailOf([root, child])
    renderWorkspace({ selectedTraceId: "t" })
    expect(screen.getByTestId("stub-timeline")).toBeInTheDocument()
    const props = timelineProps.mock.calls.at(-1)![0]
    expect((props.spans as Array<{ spanId: string }>).map((s) => s.spanId)).toEqual([
      "root",
      "child",
    ])
  })

  it("offers a per-trace export fed by that trace's spans", () => {
    const root = makeSpan({ traceId: "t", spanId: "root", startTime: 1_000, durationMs: 500 })
    const child = makeSpan({
      traceId: "t",
      spanId: "child",
      parentSpanId: "root",
      startTime: 1_100,
      durationMs: 50,
    })
    traceDetail = detailOf([root, child])
    renderWorkspace({ selectedTraceId: "t" })
    const menu = screen.getByTestId("stub-export")
    expect(menu).toHaveAttribute("data-trace", "t")
    expect(menu).toHaveAttribute("data-spans", "2")
  })

  it("passes the list query to the timeline as a highlight, not a filter", () => {
    traceDetail = detailOf([makeSpan({ spanId: "root" })])
    renderWorkspace({ selectedTraceId: "t" })
    fireEvent.change(screen.getByTestId("trace-search"), { target: { value: "bash" } })
    expect(timelineProps.mock.calls.at(-1)![0].highlightQuery).toBe("bash")
  })

  it("lets the timeline drive the span selection", () => {
    const root = makeSpan({ traceId: "t", spanId: "root", startTime: 1_000, durationMs: 500 })
    const child = makeSpan({
      traceId: "t",
      spanId: "child",
      parentSpanId: "root",
      startTime: 1_100,
      durationMs: 100,
      operationName: "execute_tool",
      toolName: "Bash",
    })
    traceDetail = detailOf([root, child])
    renderWorkspace({ selectedTraceId: "t" })
    fireEvent.click(screen.getByTestId("stub-timeline-select"))
    expect(screen.getByTestId("waterfall-select-child")).toHaveAttribute("aria-current", "true")
  })

  it("narrows the waterfall to the timeline's zoom window", () => {
    const root = makeSpan({ traceId: "t", spanId: "root", startTime: 1_000, durationMs: 500 })
    const inside = makeSpan({
      traceId: "t",
      spanId: "inside",
      parentSpanId: "root",
      startTime: 1_100,
      durationMs: 10,
    })
    const outside = makeSpan({
      traceId: "t",
      spanId: "outside",
      parentSpanId: "root",
      startTime: 1_400,
      durationMs: 10,
    })
    traceDetail = detailOf([root, inside, outside])
    renderWorkspace({ selectedTraceId: "t" })
    expect(screen.getByTestId("waterfall-row-outside")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("stub-timeline-zoom"))
    expect(screen.queryByTestId("waterfall-row-outside")).not.toBeInTheDocument()
    expect(screen.getByTestId("waterfall-row-inside")).toBeInTheDocument()
    // One count, in the timeline toolbar ("N of M spans") — no second chip.
    expect(timelineProps.mock.calls.at(-1)![0].window).toEqual({ since: 1_050, until: 1_150 })
  })

  it("clears the zoom when another trace is selected", () => {
    Object.assign(traceListResult, { traces: [row()], windowTotal: 1, matchedTotal: 1 })
    traceDetail = detailOf([makeSpan({ spanId: "root" })])
    renderWorkspace({ selectedTraceId: "t" })
    fireEvent.click(screen.getByTestId("stub-timeline-zoom"))
    expect(timelineProps.mock.calls.at(-1)![0].window).not.toBeNull()

    fireEvent.click(screen.getByTestId("trace-row-trace-1"))
    expect(useObservabilityStore.getState().timelineZoom).toBeNull()
  })

  it("moves the detail pane to whichever span is clicked", () => {
    const root = makeSpan({ traceId: "t", spanId: "root", startTime: 1_000, durationMs: 500 })
    const child = makeSpan({
      traceId: "t",
      spanId: "child",
      parentSpanId: "root",
      startTime: 1_100,
      durationMs: 100,
      operationName: "execute_tool",
      toolName: "Bash",
    })
    traceDetail = detailOf([root, child])
    renderWorkspace({ selectedTraceId: "t" })

    fireEvent.click(screen.getByTestId("waterfall-select-child"))
    expect(screen.getByTestId("waterfall-select-child")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("trace-span-detail")).toHaveTextContent("Bash")
  })

  it("resets the page and reports filter changes upward", async () => {
    const user = userEvent.setup()
    const { props } = renderWorkspace()
    await user.click(screen.getByTestId("trace-errors-only"))
    expect(props.onErrorsOnlyChange).toHaveBeenCalledWith(true)

    fireEvent.change(screen.getByTestId("trace-search"), { target: { value: "bash" } })
    // `page: null` = back to the page holding the selection, else the first.
    expect(traceListOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "bash", page: null })
    )
  })

  it("pages from the clamped page so a narrower filter cannot strand the pager", () => {
    Object.assign(traceListResult, {
      traces: [row()],
      windowTotal: 100,
      matchedTotal: 100,
      pageCount: 2,
      page: 0,
    })
    renderWorkspace()
    fireEvent.click(screen.getByTestId("trace-page-next"))
    expect(traceListOptions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }))
  })

  it("hides the pager when everything fits on one page", () => {
    Object.assign(traceListResult, { traces: [row()], windowTotal: 1, matchedTotal: 1 })
    renderWorkspace()
    expect(screen.queryByTestId("trace-page-next")).not.toBeInTheDocument()
  })

  it("swaps the explorer for the dashboard without leaving the channel", () => {
    const { rerender, props } = renderWorkspace()
    expect(screen.getByTestId("trace-list-pane")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-dashboard")).not.toBeInTheDocument()

    // Radix's tab trigger commits on `mousedown`, which is what the browser
    // sends first — `fireEvent.click` alone never reaches the handler.
    fireEvent.mouseDown(screen.getByTestId("trace-sub-view-dashboard"))
    expect(props.onSubViewChange).toHaveBeenCalledWith("dashboard")

    rerender(<TraceWorkspace {...props} subView="dashboard" />)
    expect(screen.getByTestId("stub-dashboard")).toBeInTheDocument()
    expect(screen.queryByTestId("trace-list-pane")).not.toBeInTheDocument()
  })

  it("offers layout editing only on the dashboard", () => {
    renderWorkspace()
    expect(screen.getByTestId("stub-toolbar")).toHaveAttribute("data-layout-controls", "false")
    renderWorkspace({ subView: "dashboard" })
    expect(screen.getAllByTestId("stub-toolbar").at(-1)).toHaveAttribute(
      "data-layout-controls",
      "true"
    )
  })

  it("exports the traces the list actually matched, not the whole window", () => {
    Object.assign(traceListResult, {
      traces: [row()],
      matched: [row(), row({ traceId: "trace-2" })],
      windowTotal: 9,
      matchedTotal: 2,
    })
    renderWorkspace()
    expect(screen.getByTestId("stub-toolbar")).toHaveAttribute("data-traces", "2")
  })

  it("hands a breakdown click straight into the shared filters", () => {
    renderWorkspace({ subView: "dashboard" })
    const onFilterValue = dashboardProps.mock.calls.at(-1)![0].onFilterValue as (
      dim: string,
      value: string
    ) => void
    onFilterValue("model", "opus")
    expect(useObservabilityStore.getState().filters).toEqual({ model: ["opus"] })
  })

  it("tells the dashboard the window is empty only once the read resolved", () => {
    observabilityData = { ...observabilityData, loading: true }
    renderWorkspace({ subView: "dashboard" })
    expect(screen.getByTestId("stub-dashboard")).toHaveAttribute("data-empty", "false")

    observabilityData = { ...observabilityData, loading: false }
    renderWorkspace({ subView: "dashboard" })
    expect(screen.getAllByTestId("stub-dashboard").at(-1)).toHaveAttribute("data-empty", "true")
  })

  it("collapses to list + sheet when the CHANNEL is narrow, viewport regardless", () => {
    containerWidth = 700
    Object.assign(traceListResult, { traces: [row()], windowTotal: 1, matchedTotal: 1 })
    renderWorkspace({ selectedTraceId: "trace-1" })
    expect(screen.getByTestId("trace-workspace")).toHaveAttribute("data-tier", "stacked")
    expect(screen.getByTestId("trace-list-pane")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.queryByTestId("trace-columns-layout")).not.toBeInTheDocument()
  })

  it("drops the third column before the waterfall gets unreadable", () => {
    containerWidth = 900
    renderWorkspace({ selectedTraceId: "trace-1" })
    expect(screen.getByTestId("trace-workspace")).toHaveAttribute("data-tier", "split")
    expect(screen.getByTestId("trace-split-layout")).toBeInTheDocument()
    // Still on-screen, stacked under the waterfall rather than in a sheet.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByTestId("trace-waterfall-pane")).toBeInTheDocument()
  })

  it("keeps three columns once the channel is wide enough", () => {
    containerWidth = 1400
    renderWorkspace({ selectedTraceId: "trace-1" })
    expect(screen.getByTestId("trace-workspace")).toHaveAttribute("data-tier", "columns")
    expect(screen.getByTestId("trace-columns-layout")).toBeInTheDocument()
  })

  it("mounts no pane group before the first measurement lands", () => {
    containerWidth = 0
    renderWorkspace()
    expect(screen.getByTestId("trace-workspace")).toHaveAttribute("data-tier", "pending")
    expect(screen.getByTestId("trace-layout-pending")).toBeInTheDocument()
    expect(screen.queryByTestId("trace-columns-layout")).not.toBeInTheDocument()
    // …and does not claim a compact toolbar it has no evidence for.
    expect(screen.getByTestId("stub-toolbar")).toHaveAttribute("data-compact", "false")
  })

  it("collapses the toolbar on a narrow channel and expands it on a wide one", () => {
    containerWidth = 900
    renderWorkspace()
    expect(screen.getByTestId("stub-toolbar")).toHaveAttribute("data-compact", "true")
    // 900px is narrow, but not phone-narrow — nothing is dropped there.
    expect(screen.getByTestId("stub-toolbar")).toHaveAttribute("data-dense", "false")

    containerWidth = 1400
    renderWorkspace()
    expect(screen.getAllByTestId("stub-toolbar").at(-1)).toHaveAttribute("data-compact", "false")
  })

  it("asks for the dense toolbar only at phone width", () => {
    containerWidth = 390
    renderWorkspace()
    expect(screen.getByTestId("stub-toolbar")).toHaveAttribute("data-dense", "true")
  })

  describe("dashboard drill-down", () => {
    function drill() {
      return dashboardProps.mock.calls.at(-1)![0].onDrill as (d: unknown) => void
    }

    it("turns errors-only on and switches to Explore for a failing-count stat", () => {
      const { props } = renderWorkspace({ subView: "dashboard" })
      act(() => drill()({ kind: "errors" }))
      expect(props.onErrorsOnlyChange).toHaveBeenCalledWith(true)
      expect(props.onSubViewChange).toHaveBeenCalledWith("explore")
    })

    it("pins the range to a chart point's bucket", () => {
      const { props } = renderWorkspace({ subView: "dashboard" })
      act(() => drill()({ kind: "window", since: 1_000, until: 2_000 }))
      const state = useObservabilityStore.getState()
      expect(state.rangePreset).toBe("custom")
      expect([state.customSince, state.customUntil]).toEqual([1_000, 2_000])
      expect(props.onSubViewChange).toHaveBeenCalledWith("explore")
    })

    it("makes sure a breakdown value is selected — never toggles it off", () => {
      useObservabilityStore.setState({ filters: { model: ["opus"] } })
      renderWorkspace({ subView: "dashboard" })
      act(() => drill()({ kind: "filter", dimension: "model", value: "opus" }))
      expect(useObservabilityStore.getState().filters).toEqual({ model: ["opus"] })
      act(() => drill()({ kind: "filter", dimension: "surface", value: "chat" }))
      expect(useObservabilityStore.getState().filters).toEqual({
        model: ["opus"],
        surface: ["chat"],
      })
    })

    it("hands the dashboard its first-read, error and retry states", () => {
      const error = new Error("blocked")
      observabilityData = { ...observabilityData, loading: true, error }
      renderWorkspace({ subView: "dashboard" })
      const props = dashboardProps.mock.calls.at(-1)![0]
      expect(props.loading).toBe(true)
      expect(props.error).toBe(error)
      expect(props.onRetry).toBe(retryRead)
    })
  })

  it("exports every counted trace from the Dashboard, the visible list from Explore", () => {
    Object.assign(traceListResult, {
      matched: [row()],
      all: [row(), row({ traceId: "trace-2" }), row({ traceId: "trace-3" })],
    })
    renderWorkspace({ subView: "dashboard" })
    expect(screen.getByTestId("stub-toolbar")).toHaveAttribute("data-traces", "3")
  })

  it("normalizes an imported dashboard config against the registry", () => {
    renderWorkspace({ subView: "dashboard" })
    const onImportConfig = toolbarProps.mock.calls.at(-1)![0].onImportConfig as (
      cfg: unknown
    ) => void
    act(() =>
      onImportConfig({
        version: 1,
        layouts: { lg: [{ i: "kpi-cost", x: 0, y: 0, w: 1, h: 1 }], md: [], sm: [] },
        hiddenPanels: ["kpi-cost", "no-such-panel"],
        thresholds: {},
        rangePreset: "1h",
        customSince: null,
        customUntil: null,
        refreshMs: 0,
        filters: { provider: ["anthropic"] },
      })
    )
    const state = useObservabilityStore.getState()
    expect(state.hiddenPanels).toEqual(["kpi-cost"])
    expect(state.layouts!.lg.find((item) => item.i === "kpi-cost")).toMatchObject({ w: 2, h: 2 })
    expect(state.layouts!.lg.length).toBeGreaterThan(1)
    expect(state.filters).toEqual({ provider: ["anthropic"] })
  })

  it("mirrors errors-only to the URL through the same wrapper the toggle uses", () => {
    const { props } = renderWorkspace({ errorsOnly: true })
    const options = exploreUrlSyncArgs.mock.calls.at(-1)![0] as {
      errorsOnly: boolean
      onErrorsOnlyChange: (next: boolean) => void
    }
    expect(options.errorsOnly).toBe(true)
    act(() => options.onErrorsOnlyChange(false))
    expect(props.onErrorsOnlyChange).toHaveBeenCalledWith(false)
    expect(traceListOptions).toHaveBeenLastCalledWith(expect.objectContaining({ page: null }))
  })

  it("keeps the timeline's scale and grouping in the store", () => {
    useObservabilityStore.setState({ timelineScale: "sequence", timelineGrouping: "model" })
    traceDetail = detailOf([makeSpan({ spanId: "root" })])
    renderWorkspace({ selectedTraceId: "t" })
    const props = timelineProps.mock.calls.at(-1)![0]
    expect(props.scale).toBe("sequence")
    expect(props.grouping).toBe("model")
  })

  describe("selection states", () => {
    it("says 'Trace not found' for an id with no spans, and clears it", () => {
      traceDetail = detailOf([], { notFound: true })
      const { props } = renderWorkspace({ selectedTraceId: "ghost" })
      expect(screen.getByTestId("trace-not-found")).toHaveTextContent(
        "logging.workspace.traces.notFoundTitle"
      )
      fireEvent.click(screen.getByTestId("trace-not-found-clear"))
      expect(props.onSelectTrace).toHaveBeenCalledWith(null)
    })

    it("offers a retry when the trace read fails", () => {
      traceDetail = detailOf([], { error: new Error("nope") })
      renderWorkspace({ selectedTraceId: "t" })
      fireEvent.click(screen.getByTestId("observability-retry"))
      expect(retryDetail).toHaveBeenCalled()
    })

    it("flags a selection that is not in the list", () => {
      Object.assign(traceListResult, {
        traces: [row()],
        windowTotal: 1,
        matchedTotal: 1,
        selectedIndex: -1,
      })
      traceDetail = detailOf([makeSpan({ spanId: "root" })])
      renderWorkspace({ selectedTraceId: "elsewhere" })
      expect(screen.getByTestId("trace-selection-outside")).toBeInTheDocument()
    })

    it("does not flag a selection the list holds", () => {
      Object.assign(traceListResult, {
        traces: [row()],
        windowTotal: 1,
        matchedTotal: 1,
        selectedIndex: 0,
      })
      traceDetail = detailOf([makeSpan({ spanId: "root" })])
      renderWorkspace({ selectedTraceId: "trace-1" })
      expect(screen.queryByTestId("trace-selection-outside")).not.toBeInTheDocument()
    })

    it("reveals a selection by following it to its page", () => {
      renderWorkspace({ selectedTraceId: "trace-1" })
      expect(traceListOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: null, selectedTraceId: "trace-1" })
      )
    })

    it("clears the selection with Esc and with the close button", () => {
      traceDetail = detailOf([makeSpan({ spanId: "root" })])
      const { props } = renderWorkspace({ selectedTraceId: "t" })
      fireEvent.keyDown(screen.getByTestId("trace-list-pane"), { key: "Escape" })
      expect(props.onSelectTrace).toHaveBeenLastCalledWith(null)
      ;(props.onSelectTrace as jest.Mock).mockClear()
      fireEvent.click(screen.getByTestId("trace-close"))
      expect(props.onSelectTrace).toHaveBeenLastCalledWith(null)
    })

    it("leaves Esc alone while typing in the search box", () => {
      traceDetail = detailOf([makeSpan({ spanId: "root" })])
      const { props } = renderWorkspace({ selectedTraceId: "t" })
      fireEvent.keyDown(screen.getByTestId("trace-search"), { key: "Escape" })
      expect(props.onSelectTrace).not.toHaveBeenCalled()
    })
  })

  describe("a list that holds still", () => {
    const spansAt = (...starts: number[]) =>
      starts.map((startTime, i) => makeSpan({ spanId: `s${i}`, traceId: `t${i}`, startTime }))

    it("freezes at the newest span start while a trace is selected", () => {
      observabilityData = { ...observabilityData, spans: spansAt(100, 300, 200) }
      renderWorkspace({ selectedTraceId: "t0" })
      expect(traceListOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ freezeAfter: 300 })
      )
    })

    it("does not freeze page 1 with nothing selected", () => {
      observabilityData = { ...observabilityData, spans: spansAt(100) }
      renderWorkspace()
      expect(traceListOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ freezeAfter: null })
      )
    })

    it("freezes once the user pages past the first page", () => {
      observabilityData = { ...observabilityData, spans: spansAt(100, 500) }
      Object.assign(traceListResult, { traces: [row()], pageCount: 3, windowTotal: 90 })
      renderWorkspace()
      fireEvent.click(screen.getByTestId("trace-page-next"))
      expect(traceListOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, freezeAfter: 500 })
      )
    })

    it("offers the held-back traces and brings them in on request", () => {
      observabilityData = { ...observabilityData, spans: spansAt(100) }
      Object.assign(traceListResult, { traces: [row()], windowTotal: 3, pendingCount: 2 })
      renderWorkspace({ selectedTraceId: "trace-1" })
      expect(screen.getByTestId("trace-pending")).toHaveTextContent('"count":2')
      fireEvent.click(screen.getByTestId("trace-pending"))
      expect(traceListOptions).toHaveBeenLastCalledWith(expect.objectContaining({ page: null }))
    })
  })

  it("offers to widen an empty window, and hides it at the widest preset", () => {
    renderWorkspace()
    fireEvent.click(screen.getByTestId("trace-list-widen"))
    expect(useObservabilityStore.getState().rangePreset).toBe("30d")
    renderWorkspace()
    expect(screen.getAllByTestId("trace-list-pane").at(-1)).not.toContainElement(
      screen.queryByTestId("trace-list-widen")
    )
  })

  it("shows a failed window read with a retry instead of an empty list", () => {
    observabilityData = { ...observabilityData, error: new Error("blocked") }
    renderWorkspace()
    expect(screen.queryByTestId("trace-list-empty")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("observability-retry"))
    expect(retryRead).toHaveBeenCalled()
  })

  it("moves through the list with j/k and the arrows under one tab stop", () => {
    Object.assign(traceListResult, {
      traces: [row(), row({ traceId: "trace-2" }), row({ traceId: "trace-3" })],
      windowTotal: 3,
      matchedTotal: 3,
    })
    renderWorkspace()
    const first = screen.getByTestId("trace-row-trace-1")
    expect(first).toHaveAttribute("tabindex", "0")
    expect(screen.getByTestId("trace-row-trace-2")).toHaveAttribute("tabindex", "-1")
    first.focus()
    fireEvent.keyDown(first, { key: "j" })
    expect(screen.getByTestId("trace-row-trace-2")).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId("trace-row-trace-2"), { key: "ArrowDown" })
    expect(screen.getByTestId("trace-row-trace-3")).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId("trace-row-trace-3"), { key: "k" })
    expect(screen.getByTestId("trace-row-trace-2")).toHaveFocus()
    expect(screen.getByTestId("trace-row-trace-2")).toHaveAttribute("tabindex", "0")
  })

  it("names icon-only sub-view tabs and gives them a tooltip", () => {
    containerWidth = 400
    renderWorkspace()
    const tab = screen.getByTestId("trace-sub-view-dashboard")
    expect(tab).toHaveAccessibleName("logging.workspace.traces.subViews.dashboard")
    expect(tab).toHaveAttribute("title")
  })

  describe("the stacked sheet", () => {
    beforeEach(() => {
      containerWidth = 700
      traceDetail = detailOf([makeSpan({ spanId: "root" })])
    })

    it("splits waterfall and span detail with a resizable handle", () => {
      renderWorkspace({ selectedTraceId: "t" })
      expect(screen.getByTestId("trace-sheet-split")).toBeInTheDocument()
      expect(screen.getByRole("separator")).toBeInTheDocument()
    })

    it("does not reopen after a trip to the Dashboard", () => {
      const { rerender, props } = renderWorkspace({ selectedTraceId: "t" })
      expect(screen.getByRole("dialog")).toBeInTheDocument()
      rerender(<TraceWorkspace {...props} selectedTraceId="t" subView="dashboard" />)
      rerender(<TraceWorkspace {...props} selectedTraceId="t" subView="explore" />)
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })

    it("opens again once the user picks a trace", () => {
      Object.assign(traceListResult, { traces: [row()], windowTotal: 1, matchedTotal: 1 })
      const { rerender, props } = renderWorkspace({ selectedTraceId: "trace-1" })
      rerender(<TraceWorkspace {...props} selectedTraceId="trace-1" subView="dashboard" />)
      rerender(<TraceWorkspace {...props} selectedTraceId="trace-1" subView="explore" />)
      fireEvent.click(screen.getByTestId("trace-row-trace-1"))
      expect(screen.getByRole("dialog")).toBeInTheDocument()
    })
  })
})
