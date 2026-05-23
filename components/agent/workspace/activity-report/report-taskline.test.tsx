/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { TooltipProvider } from "@/components/ui/tooltip"
import { ReportTaskline } from "./report-taskline"
import type { AgentTeammate, TeamExecutionReport } from "@/types/agent/agent-team"

// The real app mounts TooltipProvider at the layout root; provide one here so
// the segment tooltips can render in isolation.
const renderWithTooltip = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>)

const report = (checkpoints: TeamExecutionReport["checkpoints"]): TeamExecutionReport => ({
  id: "r1",
  teamId: "t1",
  status: "completed",
  checkpoints,
  createdAt: new Date(),
  updatedAt: new Date(),
})

const teammate = (id: string, name: string): AgentTeammate =>
  ({ id, name, teamId: "t1", role: "teammate", status: "idle", config: {} }) as AgentTeammate

describe("ReportTaskline", () => {
  it("shows the empty state when there are no delegation segments", () => {
    renderWithTooltip(<ReportTaskline report={report([])} teammates={[]} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders a segment for a matched start/complete pair", () => {
    const r = report([
      {
        id: "c1",
        type: "delegation_started",
        timestamp: new Date(2026, 0, 1, 10, 0, 0),
        summary: "Investigate",
        teammateId: "tm-1",
        delegationId: "d1",
      },
      {
        id: "c2",
        type: "delegation_completed",
        timestamp: new Date(2026, 0, 1, 10, 5, 0),
        summary: "done",
        teammateId: "tm-1",
        delegationId: "d1",
      },
    ])
    renderWithTooltip(<ReportTaskline report={r} teammates={[teammate("tm-1", "Worker One")]} />)
    expect(screen.getByText("Worker One")).toBeInTheDocument()
    expect(screen.getByTestId("taskline-segment-d1")).toBeInTheDocument()
  })
})
