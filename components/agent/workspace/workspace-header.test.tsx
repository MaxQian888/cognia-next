/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { WorkspaceHeader } from "./workspace-header"
import { buildTeam, buildTeammate } from "@/lib/storybook/fixtures/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Pass the durable run status straight through (override to exercise "run row
// wins over stale store status").
let liveStatusOverride: string | undefined
jest.mock("@/hooks/agent-runs/use-team-live-status", () => ({
  useTeamLiveStatus: (team: { status: string }) => liveStatusOverride ?? team.status,
}))

beforeEach(() => {
  liveStatusOverride = undefined
})

describe("WorkspaceHeader", () => {
  it("renders the team name, description and live status", () => {
    const team = buildTeam({
      name: "Squad Alpha",
      description: "Primary research team",
      status: "idle",
    })
    render(<WorkspaceHeader team={team} teammates={[]} />)
    expect(screen.getByText("Squad Alpha")).toBeInTheDocument()
    expect(screen.getByText("Primary research team")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-header-status").textContent).toContain("idle")
  })

  it("counts only worker teammates in the members chip", () => {
    const team = buildTeam({ name: "Squad", status: "idle" })
    const teammates = [
      buildTeammate({ id: "lead", role: "lead" }),
      buildTeammate({ id: "w1", role: "teammate" }),
      buildTeammate({ id: "w2", role: "teammate" }),
    ]
    render(<WorkspaceHeader team={team} teammates={teammates} />)
    expect(screen.getByTestId("workspace-stat-members").textContent).toContain("2")
  })

  it("shows the live 'working' chip only when a teammate is executing", () => {
    const team = buildTeam({ name: "Squad", status: "executing" })
    const idle = [buildTeammate({ id: "w1", role: "teammate", status: "idle" })]
    const { rerender } = render(<WorkspaceHeader team={team} teammates={idle} />)
    expect(screen.queryByTestId("workspace-stat-working")).not.toBeInTheDocument()

    rerender(
      <WorkspaceHeader
        team={team}
        teammates={[buildTeammate({ id: "w1", role: "teammate", status: "executing" })]}
      />
    )
    expect(screen.getByTestId("workspace-stat-working")).toBeInTheDocument()
  })

  it("shows the duration chip only after a run has recorded a duration", () => {
    const team = buildTeam({ name: "Squad", status: "idle" })
    const { rerender } = render(<WorkspaceHeader team={team} teammates={[]} />)
    expect(screen.queryByTestId("workspace-stat-duration")).not.toBeInTheDocument()

    rerender(
      <WorkspaceHeader team={buildTeam({ name: "Squad", totalDuration: 65_000 })} teammates={[]} />
    )
    expect(screen.getByTestId("workspace-stat-duration").textContent).toContain("1m")
  })
})
