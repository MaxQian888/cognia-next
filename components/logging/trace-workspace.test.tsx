/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { makeSpan } from "@/lib/observability/fixtures"
import { buildWaterfall } from "@/lib/observability/trace-rollup"
import type { TraceRollupRow } from "@/lib/observability/trace-rollup"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${namespace}.${key}:${JSON.stringify(vars)}` : `${namespace}.${key}`,
}))

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
jest.mock("@/hooks/observability/use-refresh-tick", () => ({
  useRefreshTick: () => ({ tick: 0, lastUpdated: null, refresh: jest.fn() }),
}))

let observabilityData = {
  spans: [] as unknown[],
  windowSpans: [] as unknown[],
  loading: false,
  spanCount: 0,
  windowSpanCount: 0,
  truncated: false,
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
  windowTotal: 0,
  matchedTotal: 0,
  pageCount: 1,
  page: 0,
  loading: false,
}
const traceListOptions = jest.fn()
jest.mock("@/hooks/logging/use-trace-list", () => ({
  useTraceList: (options: Record<string, unknown>) => {
    traceListOptions(options)
    return traceListResult
  },
}))

let traceDetail = { waterfall: buildWaterfall([]), loading: false }
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
  traceDetail = { waterfall: buildWaterfall([]), loading: false }
  observabilityData = {
    spans: [],
    windowSpans: [],
    loading: false,
    spanCount: 0,
    windowSpanCount: 0,
    truncated: false,
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
  })
  Object.assign(traceListResult, {
    traces: [],
    matched: [],
    windowTotal: 0,
    matchedTotal: 0,
    pageCount: 1,
    page: 0,
    loading: false,
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
    traceDetail = { waterfall: buildWaterfall([root, child]), loading: false }
    renderWorkspace({ selectedTraceId: "t" })

    expect(screen.getByTestId("waterfall-row-root")).toBeInTheDocument()
    expect(screen.getByTestId("waterfall-row-child")).toBeInTheDocument()
    // Root span drives the detail pane until the user picks another.
    expect(screen.getByTestId("trace-span-detail")).toBeInTheDocument()
    expect(screen.getByTestId("waterfall-row-root")).toHaveAttribute("aria-current", "true")
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
    traceDetail = { waterfall: buildWaterfall([root, child]), loading: false }
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
    traceDetail = { waterfall: buildWaterfall([root, child]), loading: false }
    renderWorkspace({ selectedTraceId: "t" })
    const menu = screen.getByTestId("stub-export")
    expect(menu).toHaveAttribute("data-trace", "t")
    expect(menu).toHaveAttribute("data-spans", "2")
  })

  it("passes the list query to the timeline as a highlight, not a filter", () => {
    traceDetail = { waterfall: buildWaterfall([makeSpan({ spanId: "root" })]), loading: false }
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
    traceDetail = { waterfall: buildWaterfall([root, child]), loading: false }
    renderWorkspace({ selectedTraceId: "t" })
    fireEvent.click(screen.getByTestId("stub-timeline-select"))
    expect(screen.getByTestId("waterfall-row-child")).toHaveAttribute("aria-current", "true")
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
    traceDetail = { waterfall: buildWaterfall([root, inside, outside]), loading: false }
    renderWorkspace({ selectedTraceId: "t" })
    expect(screen.getByTestId("waterfall-row-outside")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("stub-timeline-zoom"))
    expect(screen.queryByTestId("waterfall-row-outside")).not.toBeInTheDocument()
    expect(screen.getByTestId("waterfall-row-inside")).toBeInTheDocument()
    expect(screen.getByTestId("trace-window-chip")).toBeInTheDocument()
  })

  it("clears the zoom when another trace is selected", () => {
    Object.assign(traceListResult, { traces: [row()], windowTotal: 1, matchedTotal: 1 })
    traceDetail = { waterfall: buildWaterfall([makeSpan({ spanId: "root" })]), loading: false }
    renderWorkspace({ selectedTraceId: "t" })
    fireEvent.click(screen.getByTestId("stub-timeline-zoom"))
    expect(screen.getByTestId("trace-window-chip")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("trace-row-trace-1"))
    expect(screen.queryByTestId("trace-window-chip")).not.toBeInTheDocument()
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
    traceDetail = { waterfall: buildWaterfall([root, child]), loading: false }
    renderWorkspace({ selectedTraceId: "t" })

    const childRow = screen.getByTestId("waterfall-row-child").querySelector('[role="button"]')!
    fireEvent.click(childRow)
    expect(screen.getByTestId("waterfall-row-child")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("trace-span-detail")).toHaveTextContent("Bash")
  })

  it("resets the page and reports filter changes upward", async () => {
    const user = userEvent.setup()
    const { props } = renderWorkspace()
    await user.click(screen.getByTestId("trace-errors-only"))
    expect(props.onErrorsOnlyChange).toHaveBeenCalledWith(true)

    fireEvent.change(screen.getByTestId("trace-search"), { target: { value: "bash" } })
    expect(traceListOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "bash", page: 0 })
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

  it("renders the widest tier before the first measurement lands", () => {
    containerWidth = 0
    renderWorkspace()
    expect(screen.getByTestId("trace-workspace")).toHaveAttribute("data-tier", "columns")
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
})
