/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { AgentTraceStatsSummary } from "@/lib/db/agent-traces"
import { STATS_CARD_IDS, AgentTraceStatsBarView } from "./agent-trace-stats-bar"

jest.mock("next-intl", () => {
  // Key-echo translator (with `has`, which the enum-label hook asks before
  // translating) plus an Intl-backed formatter — what next-intl's
  // `useFormatter` does, in "en"/UTC (next-intl itself is ESM-only and cannot
  // be `requireActual`-ed here) — so units and currency render as in the app.
  const translator = () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key
  return {
    useTranslations: () => Object.assign(translator(), { has: () => false }),
    useFormatter: () => ({
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat("en", options).format(value),
      dateTime: (value: number | Date, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options }).format(value),
    }),
  }
})

function makeSummary(over: Partial<AgentTraceStatsSummary> = {}): AgentTraceStatsSummary {
  return {
    totalCost: 0,
    toolCallCount: 0,
    toolFailureCount: 0,
    avgLatencyMs: 0,
    eventTypeCounts: {},
    totalSpans: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    cacheHitRate: 0,
    errorCount: 0,
    byModel: {},
    bySurface: {},
    ...over,
  }
}

describe("AgentTraceStatsBarView", () => {
  it("renders the loading placeholder when summary is null", () => {
    render(<AgentTraceStatsBarView summary={null} window="today" />)
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("renders the headline numbers when summary is present", () => {
    const summary = makeSummary({
      totalCost: 1.234,
      totalSpans: 12,
      totalInputTokens: 12_000,
      totalOutputTokens: 3_000,
      totalCacheReadTokens: 5_000,
      cacheHitRate: 5000 / (12000 + 5000),
      toolCallCount: 4,
      toolFailureCount: 1,
      errorCount: 2,
      avgLatencyMs: 123,
    })
    render(<AgentTraceStatsBarView summary={summary} window="today" />)
    expect(screen.getByTestId("agent-trace-stats-total-cost")).toHaveTextContent("$1.23")
    expect(screen.getByTestId("agent-trace-stats-input-tokens")).toHaveTextContent("12K")
    expect(screen.getByTestId("agent-trace-stats-cache-hit-rate")).toHaveTextContent("29%")
    expect(screen.getByTestId("agent-trace-stats-tool-calls")).toHaveTextContent("4")
    expect(screen.getByTestId("agent-trace-stats-errors")).toHaveTextContent("2")
    // Latency hint carries a formatted duration, not a hard-coded " ms".
    expect(screen.getByTestId("agent-trace-stats-errors")).toHaveTextContent(
      'avgLatencyHint:{"value":"123ms"}'
    )
  })

  it("keys every card by a stable id, never by its translated label", () => {
    render(<AgentTraceStatsBarView summary={makeSummary()} window="today" />)
    for (const id of STATS_CARD_IDS) {
      expect(screen.getByTestId(`agent-trace-stats-${id}`)).toBeInTheDocument()
    }
  })

  it("renders by-model breakdown sorted by cost desc and excludes (unknown)", () => {
    const summary = makeSummary({
      byModel: {
        opus: { spans: 3, inputTokens: 100, outputTokens: 50, costUsd: 0.5 },
        haiku: { spans: 5, inputTokens: 200, outputTokens: 70, costUsd: 0.05 },
        "(unknown)": { spans: 2, inputTokens: 10, outputTokens: 1, costUsd: 0.01 },
      },
    })
    render(<AgentTraceStatsBarView summary={summary} window="all" />)
    const list = screen.getByTestId("agent-trace-stats-by-model")
    const items = list.querySelectorAll("li")
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain("opus")
    expect(items[1].textContent).toContain("haiku")
  })

  it("formats very small costs with 4 decimal places", () => {
    render(<AgentTraceStatsBarView summary={makeSummary({ totalCost: 0.0042 })} window="today" />)
    expect(screen.getByTestId("agent-trace-stats-total-cost")).toHaveTextContent("$0.0042")
  })

  it("formats $0 cleanly", () => {
    render(<AgentTraceStatsBarView summary={makeSummary({ totalCost: 0 })} window="today" />)
    expect(screen.getByTestId("agent-trace-stats-total-cost")).toHaveTextContent("$0.00")
  })

  it("indicates the active time window", () => {
    render(<AgentTraceStatsBarView summary={makeSummary()} window="week" />)
    expect(screen.getByTestId("agent-trace-stats-window")).toHaveTextContent("windows.week")
  })

  it("formats large token totals with k/M suffixes", () => {
    render(
      <AgentTraceStatsBarView summary={makeSummary({ totalInputTokens: 2_500_000 })} window="all" />
    )
    expect(screen.getByTestId("agent-trace-stats-input-tokens")).toHaveTextContent("2.5M")
  })
})
