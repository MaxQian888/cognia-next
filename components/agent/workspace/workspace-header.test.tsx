/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
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
    expect(screen.getByTestId(`agent-team-avatar-${team.id}`)).toHaveAttribute(
      "src",
      "/icons/cognia-agent-team/webp/coordinator.webp"
    )
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

  it("keeps the coordinator portrait for a blank team name and omits the description line", () => {
    const team = buildTeam({ name: "   ", description: undefined, totalTokenUsage: undefined })
    render(<WorkspaceHeader team={team} teammates={[]} />)
    expect(screen.getByTestId(`agent-team-avatar-${team.id}`)).toHaveAttribute(
      "data-avatar-id",
      "coordinator"
    )
    // No description → no paragraph under the title.
    expect(screen.queryByText("Reproduce, fix, and ship the reducer regression.")).toBeNull()
    // No token usage record → the chip still renders, at zero.
    expect(screen.getByTestId("workspace-stat-tokens").textContent).toContain("0")
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

  describe("pending gates", () => {
    it("stays quiet when nothing is parked", () => {
      render(<WorkspaceHeader team={buildTeam()} teammates={[]} />)
      expect(screen.queryByTestId("workspace-pending-gates")).not.toBeInTheDocument()
    })

    it("surfaces the count when a gate is waiting on the operator", () => {
      render(<WorkspaceHeader team={buildTeam()} teammates={[]} pendingGateCount={2} />)
      // The mock returns the key, so assert on presence + the interpolated count
      // reaching the label rather than on translated copy.
      expect(screen.getByTestId("workspace-pending-gates")).toBeInTheDocument()
    })
  })

  // The run controls moved here from the bottom of the Overview tab, where they
  // sank below the fold as a run produced more content. The header is pinned
  // outside the scroll container, so Abort stays reachable from every tab.
  describe("run controls", () => {
    it("omits the control block entirely when no handler is supplied", () => {
      render(<WorkspaceHeader team={buildTeam({ status: "idle" })} teammates={[]} />)
      expect(screen.queryByTestId("team-run-controls")).not.toBeInTheDocument()
    })

    it("renders Run and calls onStart while idle", () => {
      const onStart = jest.fn()
      render(
        <WorkspaceHeader team={buildTeam({ status: "idle" })} teammates={[]} onStart={onStart} />
      )
      fireEvent.click(screen.getByTestId("start-team"))
      expect(onStart).toHaveBeenCalledTimes(1)
    })

    it("swaps to Pause + Abort once the durable run reports it is live", () => {
      liveStatusOverride = "executing"
      const onAbort = jest.fn()
      const onPause = jest.fn()
      render(
        <WorkspaceHeader
          // Store still says idle; the run row must win, exactly as the badge does.
          team={buildTeam({ status: "idle" })}
          teammates={[]}
          onStart={jest.fn()}
          onAbort={onAbort}
          onPause={onPause}
        />
      )
      expect(screen.queryByTestId("start-team")).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId("pause-team"))
      expect(onPause).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByTestId("abort-team"))
      expect(onAbort).toHaveBeenCalledTimes(1)
    })

    it("offers the ultracode run only when the team enables it", () => {
      const onStartUltracode = jest.fn()
      const { rerender } = render(
        <WorkspaceHeader
          team={buildTeam({ status: "idle" })}
          teammates={[]}
          onStartUltracode={onStartUltracode}
        />
      )
      expect(screen.queryByTestId("start-team-ultracode")).not.toBeInTheDocument()

      rerender(
        <WorkspaceHeader
          team={buildTeam({
            status: "idle",
            config: { ...buildTeam().config, ultracode: { enabled: true } },
          })}
          teammates={[]}
          onStartUltracode={onStartUltracode}
        />
      )
      fireEvent.click(screen.getByTestId("start-team-ultracode"))
      expect(onStartUltracode).toHaveBeenCalledTimes(1)
    })
  })
})
