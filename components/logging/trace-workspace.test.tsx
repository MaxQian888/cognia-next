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

jest.mock("@/components/logging/agent-trace-stats-bar", () => ({
  AgentTraceStatsBarView: ({
    window,
    summary,
  }: {
    window: string
    summary: { totalSpans: number } | null
  }) => (
    <div
      data-testid="stats-bar"
      data-window={window}
      data-summary={summary ? String(summary.totalSpans) : "none"}
    />
  ),
}))

const traceListResult = {
  traces: [] as TraceRollupRow[],
  windowTotal: 0,
  matchedTotal: 0,
  pageCount: 1,
  page: 0,
  loading: false,
  summary: { totalSpans: 0 } as { totalSpans: number } | null,
  spanCount: 0,
  windowSpanCount: 0,
  truncated: false,
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

let narrow = false
jest.mock("@/hooks/ui", () => ({
  useIsNarrow: () => narrow,
  useResizableLayout: () => ({ defaultLayout: undefined, onLayoutChanged: jest.fn() }),
  // `TraceSpanDetail` renders real copy buttons; the clipboard is not the
  // subject here.
  useCopy: () => ({ copied: false, isCopying: false, copy: jest.fn(async () => true) }),
}))

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
    window: "today" as const,
    onWindowChange: jest.fn(),
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
  narrow = false
  traceDetail = { waterfall: buildWaterfall([]), loading: false }
  Object.assign(traceListResult, {
    traces: [],
    windowTotal: 0,
    matchedTotal: 0,
    pageCount: 1,
    page: 0,
    loading: false,
    summary: { totalSpans: 0 },
    spanCount: 0,
    windowSpanCount: 0,
    truncated: false,
  })
})

describe("TraceWorkspace", () => {
  it("feeds the stats bar the list's own summary — one window read, not two", () => {
    Object.assign(traceListResult, { summary: { totalSpans: 42 } })
    renderWorkspace({ window: "week" })
    const bar = screen.getByTestId("stats-bar")
    expect(bar).toHaveAttribute("data-window", "week")
    expect(bar).toHaveAttribute("data-summary", "42")
    expect(traceListOptions).toHaveBeenCalledWith(expect.objectContaining({ window: "week" }))
  })

  it("passes the loading summary through as null rather than zeros", () => {
    Object.assign(traceListResult, { summary: null })
    renderWorkspace()
    expect(screen.getByTestId("stats-bar")).toHaveAttribute("data-summary", "none")
  })

  it("says so when the window read was capped", () => {
    Object.assign(traceListResult, {
      truncated: true,
      spanCount: 20_000,
      windowSpanCount: 61_004,
      traces: [row()],
      windowTotal: 1,
      matchedTotal: 1,
    })
    renderWorkspace()
    expect(screen.getByTestId("trace-truncated-notice")).toHaveTextContent('"total":61004')
  })

  it("hides the truncation notice for a window that fits", () => {
    Object.assign(traceListResult, { traces: [row()], windowTotal: 1, matchedTotal: 1 })
    renderWorkspace()
    expect(screen.queryByTestId("trace-truncated-notice")).not.toBeInTheDocument()
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

  it("links across to the aggregate dashboard", () => {
    renderWorkspace()
    expect(screen.getByRole("link", { name: /openDashboard/ })).toHaveAttribute(
      "href",
      "/observability"
    )
  })

  it("collapses to list + sheet on narrow viewports", () => {
    narrow = true
    Object.assign(traceListResult, { traces: [row()], windowTotal: 1, matchedTotal: 1 })
    renderWorkspace({ selectedTraceId: "trace-1" })
    expect(screen.getByTestId("trace-list-pane")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})
