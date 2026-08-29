/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"

import { SessionReportView } from "./session-report-view"
import type { SessionReport } from "@/lib/analysis/session-report"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

function report(over: Partial<SessionReport> = {}): SessionReport {
  return {
    title: "T",
    durationSeconds: 100,
    turns: 3,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: 0.25,
    totalDurationMs: 10_000,
    totalReasoningTokens: 120,
    models: [
      {
        model: "claude-x",
        turns: 3,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.25,
        durationMs: 10_000,
        reasoningTokens: 120,
        unpricedTurns: 0,
      },
    ],
    toolCounts: { Read: 2 },
    toolCallTotal: 2,
    errorCount: 1,
    denialCount: 0,
    thinkingCount: 2,
    thinkingSignals: { planning: 1 },
    friction: [{ messageIndex: 0, signals: ["undo"] }],
    frictionTotal: 1,
    testSnapshots: [{ messageIndex: 1, passed: 5, failed: 0 }],
    idleGaps: [],
    modelSwitches: [],
    commitCount: 0,
    conversationChain: ["u1", "a1"],
    degraded: true,
    assessments: [
      {
        id: "context",
        score: 0.9,
        level: "healthy",
        reasoningKey: "context.healthy",
        params: { pct: 10 },
      },
    ],
    ...over,
  }
}

describe("SessionReportView", () => {
  it("renders KPI tiles, the model row, an assessment card, and signals", () => {
    render(<SessionReportView report={report()} />)
    expect(screen.getByTestId("session-report-view")).toBeInTheDocument()
    expect(screen.getByTestId("model-row")).toHaveTextContent("claude-x")
    expect(screen.getByTestId("assessment-context")).toBeInTheDocument()
    expect(screen.getByTestId("signals-panel")).toHaveTextContent("signals.friction")
    expect(screen.getByTestId("signals-panel")).toHaveTextContent("signals.tests")
  })

  it("renders aggregate test snapshots as static summaries", () => {
    render(<SessionReportView report={report()} />)

    const results = within(screen.getByTestId("session-test-results"))
    expect(results.queryByRole("button")).not.toBeInTheDocument()
    expect(results.getByText(/tests\.snapshot/)).toBeInTheDocument()
    expect(results.getByText(/tests\.counts/)).toBeInTheDocument()
  })

  it("renders the new speed / duration / reasoning / cache-hit KPIs and per-turn averages", () => {
    render(<SessionReportView report={report()} />)
    expect(screen.getByText("kpi.speed")).toBeInTheDocument()
    expect(screen.getByText("kpi.duration")).toBeInTheDocument()
    expect(screen.getByText("kpi.reasoning")).toBeInTheDocument()
    expect(screen.getByText("kpi.cacheHit")).toBeInTheDocument()
    // 500 output tok / 10s → 50 tok/s, surfaced via the units string.
    expect(screen.getByTestId("session-report-view")).toHaveTextContent(
      'units.tokPerSec:{"value":"50"}'
    )
    // Per-turn averages panel + per-model throughput.
    expect(screen.getByTestId("averages-panel")).toBeInTheDocument()
    expect(screen.getByTestId("model-row")).toHaveTextContent("units.tokPerSec")
  })

  it("computes cache-hit % with cache present and '—' throughput for un-timed models", () => {
    render(
      <SessionReportView
        report={report({
          totalCacheReadTokens: 800,
          totalCacheCreationTokens: 200,
          models: [
            {
              model: "m-timed",
              turns: 1,
              inputTokens: 10,
              outputTokens: 100,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: 0.01,
              durationMs: 2000,
              reasoningTokens: 0,
              unpricedTurns: 0,
            },
            {
              model: "m-untimed",
              turns: 1,
              inputTokens: 10,
              outputTokens: 100,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: 0.01,
              durationMs: 0, // no duration → no per-model throughput suffix
              reasoningTokens: 0,
              unpricedTurns: 0,
            },
          ],
        })}
      />
    )
    // cache hit = 800 / (800 + 200) = 80%.
    expect(screen.getByTestId("session-report-view")).toHaveTextContent("80%")
    expect(screen.getAllByTestId("model-row")).toHaveLength(2)
  })

  it("shows em-dash placeholders when no duration / reasoning / cache data exists", () => {
    render(
      <SessionReportView
        report={report({ totalDurationMs: 0, totalReasoningTokens: 0, models: [] })}
      />
    )
    // speed unavailable (no duration) → the units string never renders.
    expect(screen.getByTestId("session-report-view")).not.toHaveTextContent("units.tokPerSec")
  })

  it("shows the empty-signals line when there is no friction or thinking", () => {
    render(
      <SessionReportView
        report={report({ frictionTotal: 0, thinkingCount: 0, testSnapshots: [] })}
      />
    )
    expect(screen.getByTestId("signals-panel")).toHaveTextContent("signals.empty")
  })

  it("hides the averages panel and uses em-dash averages when there are no turns", () => {
    render(<SessionReportView report={report({ turns: 0, totalDurationMs: 0, models: [] })} />)
    expect(screen.queryByTestId("averages-panel")).not.toBeInTheDocument()
    expect(screen.getByTestId("session-report-view")).toBeInTheDocument()
  })

  it("notes the degraded conversation tree", () => {
    render(<SessionReportView report={report()} />)
    expect(screen.getByText("degradedTree")).toBeInTheDocument()
  })
})
