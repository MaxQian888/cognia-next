/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { makeSpan } from "@/lib/observability/fixtures"
import { TraceSpanDetail, resolveSpanStatus } from "./trace-span-detail"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const copy = jest.fn(async () => true)
jest.mock("@/hooks/ui", () => ({
  useCopy: () => ({ copied: false, isCopying: false, copy }),
}))

beforeEach(() => {
  copy.mockClear()
})

describe("TraceSpanDetail", () => {
  it("renders an empty state when no span is selected", () => {
    render(<TraceSpanDetail span={null} traceStart={0} />)
    expect(screen.getByTestId("trace-span-detail-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("trace-span-detail")).not.toBeInTheDocument()
  })

  it("shows timing relative to the trace start, not epoch", () => {
    const span = makeSpan({ startTime: 5_000, durationMs: 250 })
    render(<TraceSpanDetail span={span} traceStart={4_000} />)
    expect(screen.getByText("+1.00s")).toBeInTheDocument()
  })

  it("breaks token usage down including the cache-write TTL split", () => {
    const span = makeSpan({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 30,
        cacheReadTokens: 20,
        cacheCreation5mTokens: 10,
        cacheCreation1hTokens: 20,
      },
      costUsdEstimate: 0.0123,
    })
    render(<TraceSpanDetail span={span} traceStart={span.startTime} />)
    const usage = screen.getByTestId("trace-span-usage")
    expect(usage).toHaveTextContent("cacheRead")
    expect(usage).toHaveTextContent("cacheWriteSplit")
    expect(usage).toHaveTextContent("totalTokens")
  })

  it("omits the usage section entirely for spans with no usage", () => {
    render(<TraceSpanDetail span={makeSpan()} traceStart={0} />)
    expect(screen.queryByTestId("trace-span-usage")).not.toBeInTheDocument()
  })

  it("surfaces error, handoff, events, content, and metadata when present", () => {
    const span = makeSpan({
      startTime: 1_000,
      errorType: "ToolError",
      errorMessage: "boom",
      handoff: { fromAgent: "a", toAgent: "b", reason: "escalate" },
      events: [{ name: "tool_call", at: 1_120 }],
      inputPreview: "hello",
      outputPreview: "world",
      metadata: { attempt: 2 },
    })
    render(<TraceSpanDetail span={span} traceStart={1_000} />)
    expect(screen.getByTestId("trace-span-error")).toHaveTextContent("boom")
    expect(screen.getByTestId("trace-span-handoff")).toHaveTextContent("escalate")
    expect(screen.getByTestId("trace-span-events")).toHaveTextContent("+120ms")
    expect(screen.getByTestId("trace-span-content")).toHaveTextContent("hello")
    expect(screen.getByTestId("trace-span-metadata")).toHaveTextContent("attempt")
  })

  it("copies identifiers and offers the two jumps", () => {
    const onOpenInLogs = jest.fn()
    const onOpenSession = jest.fn()
    const span = makeSpan({ traceId: "trace-x", spanId: "span-x", sessionId: "sess-x" })
    render(
      <TraceSpanDetail
        span={span}
        traceStart={span.startTime}
        onOpenInLogs={onOpenInLogs}
        onOpenSession={onOpenSession}
      />
    )
    fireEvent.click(screen.getByLabelText("traceId: trace-x"))
    expect(copy).toHaveBeenCalledWith("trace-x")

    fireEvent.click(screen.getByTestId("trace-span-open-logs"))
    expect(onOpenInLogs).toHaveBeenCalledWith("trace-x")
    fireEvent.click(screen.getByTestId("trace-span-open-session"))
    expect(onOpenSession).toHaveBeenCalledWith("sess-x")
  })

  it("hides the jumps when the host supplies no handlers", () => {
    render(<TraceSpanDetail span={makeSpan()} traceStart={0} />)
    expect(screen.queryByTestId("trace-span-open-logs")).not.toBeInTheDocument()
    expect(screen.queryByTestId("trace-span-open-session")).not.toBeInTheDocument()
  })
})

describe("resolveSpanStatus", () => {
  it("uses the explicit status when the row carries one", () => {
    expect(resolveSpanStatus(makeSpan({ status: "incomplete" }))).toBe("incomplete")
  })

  it("reads pre-v172 rows as settled, erroring only when they recorded an error", () => {
    expect(resolveSpanStatus(makeSpan())).toBe("ok")
    expect(resolveSpanStatus(makeSpan({ errorType: "Boom" }))).toBe("error")
  })
})
