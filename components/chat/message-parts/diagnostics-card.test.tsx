/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { DiagnosticsCard } from "./diagnostics-card"
import type {
  ContextDiagnosticsBlock,
  CostDiagnosticsBlock,
  UsageDiagnosticsBlock,
} from "@/lib/slash-commands/system-blocks"

const window = {
  used: 500,
  max: 200_000,
  fraction: 0.0025,
  remaining: 199_500,
  level: "ok" as const,
  compactThresholdTokens: 167_000,
  autoCompactFraction: 0.835,
}

describe("DiagnosticsCard", () => {
  it("renders a context card with messages, window bar and token rows", () => {
    const block: ContextDiagnosticsBlock = {
      kind: "context",
      userTurns: 1,
      assistantTurns: 2,
      tokens: { input: 1200, output: 800, cacheRead: 100, cacheCreate: 200 },
      window,
    }
    render(<DiagnosticsCard block={block} />)
    expect(screen.getByTestId("diagnostics-card")).toBeInTheDocument()
    expect(screen.getByText("Context")).toBeInTheDocument()
    expect(screen.getByText("1 user · 2 assistant")).toBeInTheDocument()
    // Window bar (reused composer header) renders a progressbar.
    expect(screen.getByTestId("context-window-bar")).toBeInTheDocument()
    // Cache row only shows when there are cache hits.
    expect(screen.getByText("write 200 · read 100")).toBeInTheDocument()
  })

  it("renders the fresh-window hint when no window is present", () => {
    const block: ContextDiagnosticsBlock = {
      kind: "context",
      userTurns: 1,
      assistantTurns: 0,
    }
    render(<DiagnosticsCard block={block} />)
    expect(screen.getByText(/context window is fresh/i)).toBeInTheDocument()
    expect(screen.queryByTestId("context-window-bar")).not.toBeInTheDocument()
  })

  it("renders a cost card with an estimated-cost marker", () => {
    const block: CostDiagnosticsBlock = {
      kind: "cost",
      assistantTurns: 2,
      metricTurns: 2,
      inputTokens: 1500,
      outputTokens: 2000,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0.05,
      costEstimated: true,
      durationMs: 1500,
      window,
    }
    render(<DiagnosticsCard block={block} />)
    expect(screen.getByText("Cost & usage")).toBeInTheDocument()
    expect(screen.getByText("2 assistant (2 with metrics)")).toBeInTheDocument()
    expect(screen.getByText(/estimated/i)).toBeInTheDocument()
    expect(screen.getByText("1.5s")).toBeInTheDocument()
  })

  it("renders a context card with a window but no token tallies", () => {
    const block: ContextDiagnosticsBlock = {
      kind: "context",
      userTurns: 0,
      assistantTurns: 1,
      window,
    }
    render(<DiagnosticsCard block={block} />)
    expect(screen.getByTestId("context-window-bar")).toBeInTheDocument()
    // No token rows → no cache line either.
    expect(screen.queryByText(/write/)).not.toBeInTheDocument()
  })

  it("omits the cache row when there are no cache hits", () => {
    const block: ContextDiagnosticsBlock = {
      kind: "context",
      userTurns: 1,
      assistantTurns: 1,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 },
      window,
    }
    render(<DiagnosticsCard block={block} />)
    expect(screen.queryByText(/write/)).not.toBeInTheDocument()
  })

  it("renders a cost card with cache hits, no priced cost, no duration and no window", () => {
    const block: CostDiagnosticsBlock = {
      kind: "cost",
      assistantTurns: 1,
      metricTurns: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreateTokens: 7,
      cacheReadTokens: 3,
      costUsd: null,
      costEstimated: false,
      durationMs: 0,
    }
    render(<DiagnosticsCard block={block} />)
    expect(screen.getByText("write 7 · read 3")).toBeInTheDocument()
    expect(screen.queryByText(/estimated/i)).not.toBeInTheDocument()
    // costUsd null → no $ figure; durationMs 0 → no duration; no window bar.
    expect(screen.queryByTestId("context-window-bar")).not.toBeInTheDocument()
  })

  it("renders a non-estimated cost figure", () => {
    const block: CostDiagnosticsBlock = {
      kind: "cost",
      assistantTurns: 1,
      metricTurns: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0.1234,
      costEstimated: false,
      durationMs: 0,
    }
    render(<DiagnosticsCard block={block} />)
    expect(screen.getByText("$0.1234")).toBeInTheDocument()
    expect(screen.queryByText(/estimated/i)).not.toBeInTheDocument()
  })

  it("renders usage windows with no reset countdown and an expired window", () => {
    const block: UsageDiagnosticsBlock = {
      kind: "usage",
      windows: [
        { key: "fiveHour", utilization: 10, level: "ok", msUntilReset: null },
        { key: "sevenDay", utilization: 99, level: "crit", msUntilReset: 0 },
      ],
      fallbackPercentage: null,
      overageDisabledReason: null,
    }
    render(<DiagnosticsCard block={block} />)
    expect(screen.getByText("10% used")).toBeInTheDocument()
    expect(screen.getByText(/resetting/i)).toBeInTheDocument()
    // No fallback / overage rows when both are null.
    expect(screen.queryByText("Fallback")).not.toBeInTheDocument()
    expect(screen.queryByText("Overage disabled")).not.toBeInTheDocument()
  })

  it("renders a usage card with utilization bars and a not-reported window", () => {
    const block: UsageDiagnosticsBlock = {
      kind: "usage",
      windows: [
        { key: "fiveHour", utilization: 42, level: "ok", msUntilReset: 4_500_000 },
        { key: "sevenDay", utilization: null, level: null, msUntilReset: null },
      ],
      fallbackPercentage: 12,
      overageDisabledReason: "spend cap reached",
    }
    render(<DiagnosticsCard block={block} />)
    expect(screen.getByText("Subscription usage")).toBeInTheDocument()
    expect(screen.getByTestId("usage-window-fiveHour")).toBeInTheDocument()
    expect(screen.getByText("42% used")).toBeInTheDocument()
    expect(screen.getByText("not reported")).toBeInTheDocument()
    expect(screen.getByText("12%")).toBeInTheDocument()
    expect(screen.getByText("spend cap reached")).toBeInTheDocument()
  })
})
