/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { ReportPluginSlot } from "./report-plugin-slot"
import type { AgentTeam, TeamExecutionReport } from "@/types/agent/agent-team"

describe("ReportPluginSlot", () => {
  it("renders the placeholder when no analytics renderer is registered", () => {
    const report = {
      id: "r1",
      teamId: "t1",
      status: "completed",
      checkpoints: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TeamExecutionReport
    render(<ReportPluginSlot report={report} team={{ id: "t1" } as AgentTeam} />)
    expect(screen.getByTestId("report-plugin-slot-placeholder")).toBeInTheDocument()
  })
})
