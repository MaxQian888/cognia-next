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

  it("surfaces a live progress row per task, excluded from the event list", () => {
    const progress: AgentTeamEvent = {
      type: "progress_update",
      teamId: "t1",
      teammateId: "tm1",
      taskId: "task-1",
      timestamp: new Date(2026, 0, 3),
      data: {
        phase: "running",
        teammateName: "Researcher",
        currentTool: "Bash",
        toolCount: 2,
        charCount: 40,
        elapsedMs: 3000,
      },
    }
    const other: AgentTeamEvent = {
      type: "task_started",
      teamId: "t1",
      timestamp: new Date(2026, 0, 2),
    }
    render(<AgentTeamActivity events={[other, progress]} />)

    const live = screen.getByTestId("activity-live-task-1")
    expect(live.textContent).toContain("Researcher")
    expect(live.textContent).toContain("Bash")
    // progress frames are NOT rendered in the chronological list.
    const rows = screen.queryAllByTestId(/activity-row-/)
    expect(rows.map((r) => r.textContent).join(" ")).not.toContain("progress_update")
  })

  it("keeps only the latest frame per task and renders distinct tasks", () => {
    const stale: AgentTeamEvent = {
      type: "progress_update",
      teamId: "t1",
      taskId: "task-1",
      timestamp: new Date(2026, 0, 1),
      data: { phase: "start" },
    }
    const fresh: AgentTeamEvent = {
      type: "progress_update",
      teamId: "t1",
      taskId: "task-1",
      timestamp: new Date(2026, 0, 4),
      data: { phase: "running", toolCount: 5 },
    }
    const otherTask: AgentTeamEvent = {
      type: "progress_update",
      teamId: "t1",
      taskId: "task-2",
      timestamp: new Date(2026, 0, 2),
      data: { phase: "running" },
    }
    render(<AgentTeamActivity events={[stale, fresh, otherTask]} />)
    expect(screen.getByTestId("activity-live-task-1")).toBeInTheDocument()
    expect(screen.getByTestId("activity-live-task-2")).toBeInTheDocument()
    expect(screen.getAllByTestId(/activity-live-task-/)).toHaveLength(2)
  })
})
