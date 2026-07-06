/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

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
    models: [
      {
        model: "claude-x",
        turns: 3,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.25,
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

  it("shows the empty-signals line when there is no friction or thinking", () => {
    render(
      <SessionReportView
        report={report({ frictionTotal: 0, thinkingCount: 0, testSnapshots: [] })}
      />
    )
    expect(screen.getByTestId("signals-panel")).toHaveTextContent("signals.empty")
  })

  it("notes the degraded conversation tree", () => {
    render(<SessionReportView report={report()} />)
    expect(screen.getByText("degradedTree")).toBeInTheDocument()
  })
})
