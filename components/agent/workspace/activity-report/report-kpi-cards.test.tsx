/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { ReportKpiCards } from "./report-kpi-cards"
import type { TeamExecutionReport } from "@/types/agent/agent-team"

const baseReport = (over: Partial<TeamExecutionReport> = {}): TeamExecutionReport => ({
  id: "r1",
  teamId: "t1",
  status: "completed",
  checkpoints: [],
  createdAt: new Date(2026, 0, 1, 10, 0, 0),
  updatedAt: new Date(2026, 0, 1, 10, 5, 0),
  completedAt: new Date(2026, 0, 1, 10, 5, 0),
  ...over,
})

describe("ReportKpiCards", () => {
  it("renders four KPI cards with a populated summary", () => {
    const report = baseReport({
      summary: {
        completedTasks: 8,
        failedTasks: 2,
        cancelledTasks: 0,
        blockedTasks: 0,
        delegatedTasks: 3,
        approvalsRequested: 1,
        retries: 0,
        totalTokens: 12000,
        nextActions: [],
      },
      checkpoints: [
        {
          id: "c1",
          type: "budget_escalated",
          timestamp: new Date(),
          summary: "x",
        },
      ],
    })
    render(<ReportKpiCards report={report} />)
    expect(screen.getByTestId("report-kpi-cards")).toBeInTheDocument()
    expect(screen.getByText("80%")).toBeInTheDocument() // 8/(8+2)
    expect(screen.getByText("12.0k")).toBeInTheDocument() // formatNumber(12000)
    expect(screen.getByText("1")).toBeInTheDocument() // 1 escalation
  })

  it("renders zeros when the summary is missing", () => {
    render(<ReportKpiCards report={baseReport()} />)
    expect(screen.getByText("0%")).toBeInTheDocument()
  })
})
