/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { TraceWaterfallDrawer } from "./trace-waterfall-drawer"
import { buildWaterfall } from "@/lib/observability/trace-rollup"
import { makeSpan } from "@/lib/observability/fixtures"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockDetail = jest.fn()
jest.mock("@/hooks/observability/use-trace-detail", () => ({
  useTraceDetail: (traceId: string | null) => mockDetail(traceId),
}))

describe("TraceWaterfallDrawer", () => {
  beforeEach(() => jest.clearAllMocks())

  it("renders nothing visible when no trace is selected", () => {
    mockDetail.mockReturnValue({ waterfall: buildWaterfall([]), loading: false })
    render(<TraceWaterfallDrawer traceId={null} onClose={jest.fn()} />)
    expect(screen.queryByText("title")).not.toBeInTheDocument()
  })

  it("renders a loading skeleton", () => {
    mockDetail.mockReturnValue({ waterfall: buildWaterfall([]), loading: true })
    render(<TraceWaterfallDrawer traceId="t1" onClose={jest.fn()} />)
    expect(screen.getByTestId("waterfall-loading")).toBeInTheDocument()
  })

  it("renders the waterfall rows for a trace", () => {
    const wf = buildWaterfall([
      makeSpan({
        traceId: "t1",
        spanId: "root",
        startTime: 1000,
        durationMs: 500,
        operationName: "chat",
      }),
      makeSpan({
        traceId: "t1",
        spanId: "child",
        parentSpanId: "root",
        startTime: 1100,
        durationMs: 200,
        operationName: "execute_tool",
        toolName: "Bash",
      }),
    ])
    mockDetail.mockReturnValue({ waterfall: wf, loading: false })
    render(<TraceWaterfallDrawer traceId="t1" onClose={jest.fn()} />)
    expect(screen.getByTestId("waterfall-row-root")).toBeInTheDocument()
    expect(screen.getByTestId("waterfall-row-child")).toBeInTheDocument()
  })

  it("shows the empty state for a trace with no spans", () => {
    mockDetail.mockReturnValue({ waterfall: buildWaterfall([]), loading: false })
    render(<TraceWaterfallDrawer traceId="t1" onClose={jest.fn()} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })
})
