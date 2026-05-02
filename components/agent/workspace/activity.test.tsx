/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { AgentTeamActivity } from "./activity"
import type { AgentTeamEvent } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("AgentTeamActivity", () => {
  it("renders the empty state when no events", () => {
    render(<AgentTeamActivity events={[]} />)
    expect(screen.getByTestId("activity-empty")).toBeInTheDocument()
  })

  it("renders newest event first", () => {
    const older: AgentTeamEvent = {
      type: "team_started",
      teamId: "t1",
      timestamp: new Date(2026, 0, 1),
    }
    const newer: AgentTeamEvent = {
      type: "team_completed",
      teamId: "t1",
      timestamp: new Date(2026, 0, 2),
    }
    render(<AgentTeamActivity events={[older, newer]} />)
    const rows = screen.getAllByTestId(/activity-row-/)
    expect(rows[0]?.textContent).toContain("team_completed")
    expect(rows[1]?.textContent).toContain("team_started")
  })
})
