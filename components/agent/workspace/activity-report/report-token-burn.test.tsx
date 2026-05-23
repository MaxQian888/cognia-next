/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

// Recharts' ResponsiveContainer needs real layout; stub the chart primitives
// to plain divs so the component renders deterministically in jsdom.
jest.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    Area: () => <div data-testid="area" />,
    AreaChart: Pass,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
  }
})
jest.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="chart-container">{children}</div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}))

import React from "react"
import { ReportTokenBurn } from "./report-token-burn"
import type { TeamExecutionReport } from "@/types/agent/agent-team"

const report = (checkpoints: TeamExecutionReport["checkpoints"]): TeamExecutionReport => ({
  id: "r1",
  teamId: "t1",
  status: "completed",
  checkpoints,
  createdAt: new Date(),
  updatedAt: new Date(),
})

describe("ReportTokenBurn", () => {
  it("renders the empty state when no token deltas are present", () => {
    render(<ReportTokenBurn report={report([])} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders the chart container when token data is present", () => {
    const r = report([
      {
        id: "c1",
        type: "task_completed",
        timestamp: new Date(),
        summary: "x",
        data: { tokens: 500 },
      },
    ])
    render(<ReportTokenBurn report={r} />)
    expect(screen.getByTestId("report-token-burn")).toBeInTheDocument()
    // Empty state must NOT show when there is token data.
    expect(screen.queryByText("empty")).not.toBeInTheDocument()
  })
})
