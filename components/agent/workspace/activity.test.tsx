/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { AgentTeamActivity } from "./activity"
import { TooltipProvider } from "@/components/ui/tooltip"
import { buildReport, buildTeam } from "@/lib/storybook/fixtures/agent-team"
import type { AgentTeam, AgentTeamEvent } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// TeamRunsList drives a Dexie liveQuery; stub it so the activity layout can be
// asserted without a database. Its own behaviour is covered by runs-list.test.
jest.mock("../team/runs-list", () => {
  const React = jest.requireActual("react")
  return { TeamRunsList: () => React.createElement("div", { "data-testid": "runs-stub" }) }
})

describe("AgentTeamActivity", () => {
  it("renders the empty state when no events", () => {
    render(<AgentTeamActivity events={[]} />)
    expect(screen.getByTestId("activity-empty")).toBeInTheDocument()
  })

  it("shows the runs card only when a team is provided", () => {
    const { rerender } = render(<AgentTeamActivity events={[]} />)
    expect(screen.queryByTestId("activity-runs")).not.toBeInTheDocument()

    const team = { id: "team-1" } as unknown as AgentTeam
    rerender(<AgentTeamActivity events={[]} team={team} />)
    expect(screen.getByTestId("activity-runs")).toBeInTheDocument()
    expect(screen.getByTestId("runs-stub")).toBeInTheDocument()
  })

  it("renders the execution report (KPI + checkpoint timeline) when present", () => {
    render(
      <TooltipProvider>
        <AgentTeamActivity events={[]} report={buildReport()} team={buildTeam()} teammates={[]} />
      </TooltipProvider>
    )
    expect(screen.getByTestId("activity-report")).toBeInTheDocument()
    expect(screen.getByTestId("activity-report-timeline")).toBeInTheDocument()
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

  it("shows a starting label instead of counters before the first tool lands", () => {
    // At phase "start" the tool/char/elapsed counters are all zero; printing
    // "0 tools, 0 chars, 0s" reads as stalled rather than starting.
    const starting: AgentTeamEvent = {
      type: "progress_update",
      teamId: "t1",
      teammateId: "tm1",
      taskId: "task-9",
      timestamp: new Date(2026, 0, 3),
      data: { phase: "start", teammateName: "Researcher" },
    }
    render(<AgentTeamActivity events={[starting]} />)
    const live = screen.getByTestId("activity-live-task-9")
    expect(live.textContent).toContain("liveProgressStarting")
    expect(live.textContent).not.toContain("liveProgress ")
  })

  it("renders the report timeline's empty state when a run recorded no checkpoints", () => {
    const report = { ...buildReport(), checkpoints: [] }
    render(
      <TooltipProvider>
        <AgentTeamActivity events={[]} report={report} />
      </TooltipProvider>
    )
    expect(screen.getByTestId("activity-report-timeline").textContent).toContain("emptyCheckpoints")
  })
})
