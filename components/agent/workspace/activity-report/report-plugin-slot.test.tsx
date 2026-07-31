/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: ({
    point,
    context,
    fallback,
  }: {
    point: string
    context?: Record<string, unknown>
    fallback?: React.ReactNode
  }) => (
    <div data-testid={`slot-${point}`} data-context={JSON.stringify(context)}>
      {fallback}
    </div>
  ),
}))

import { ReportPluginSlot } from "./report-plugin-slot"
import type { AgentTeam, TeamExecutionReport } from "@/types/agent/agent-team"

const baseReport = {
  id: "r1",
  teamId: "t1",
  status: "completed",
  checkpoints: [],
  createdAt: new Date(),
  updatedAt: new Date(),
} as TeamExecutionReport

describe("ReportPluginSlot", () => {
  it("mounts the agent.team.report extension slot with ids + redacted aggregates", () => {
    const report = {
      ...baseReport,
      traceSessionId: "trace_9",
      summary: {
        completedTasks: 3,
        failedTasks: 0,
        cancelledTasks: 0,
        delegatedTasks: 0,
        blockedTasks: 0,
        approvalsRequested: 0,
        retries: 0,
        totalTokens: 4200,
        nextActions: [],
      },
    } as TeamExecutionReport
    render(<ReportPluginSlot report={report} team={{ id: "t1" } as AgentTeam} />)
    const slot = screen.getByTestId("slot-agent.team.report")
    const ctx = JSON.parse(slot.getAttribute("data-context") ?? "{}")
    expect(ctx).toMatchObject({
      teamId: "t1",
      reportId: "r1",
      status: "completed",
      traceSessionId: "trace_9",
      completedTasks: 3,
      totalTokens: 4200,
    })
  })

  it("renders the placeholder fallback when no analytics renderer is registered", () => {
    render(<ReportPluginSlot report={baseReport} team={{ id: "t1" } as AgentTeam} />)
    expect(screen.getByTestId("report-plugin-slot-placeholder")).toBeInTheDocument()
  })
})
