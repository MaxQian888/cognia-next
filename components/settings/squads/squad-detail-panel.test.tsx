/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SquadDetailPanel } from "./squad-detail-panel"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

function squad(over: Partial<AgentTeam> = {}): AgentTeam {
  // `teammateIds` and `config` are load-bearing for `deleteTeam`, which walks
  // the roster to shut live members down before cleanup.
  return {
    id: "sq-1",
    name: "Research",
    description: "Digs things up",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    config: {},
    ...over,
  } as AgentTeam
}

function member(over: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: "m1",
    teamId: "sq-1",
    name: "Scout",
    status: "idle",
    progress: 0,
    ...over,
  } as AgentTeammate
}

function seed(teams: AgentTeam[], members: AgentTeammate[] = []) {
  useAgentTeamStore.setState({
    teams: Object.fromEntries(teams.map((t) => [t.id, t])) as never,
    teammates: Object.fromEntries(members.map((m) => [m.id, m])) as never,
  })
}

beforeEach(() => seed([squad()]))

describe("SquadDetailPanel", () => {
  it("shows the Squad's name and description", () => {
    render(<SquadDetailPanel squadId="sq-1" />)
    expect(screen.getByLabelText(/name/i)).toHaveValue("Research")
    expect(screen.getByLabelText(/description/i)).toHaveValue("Digs things up")
  })

  it("commits a rename on blur, not on every keystroke", async () => {
    // Writing through on each keystroke fights the input's own cursor.
    render(<SquadDetailPanel squadId="sq-1" />)
    const input = screen.getByLabelText(/name/i)
    await userEvent.clear(input)
    await userEvent.type(input, "Refactor Crew")
    expect(useAgentTeamStore.getState().teams["sq-1"]!.name).toBe("Research")
    fireEvent.blur(input)
    expect(useAgentTeamStore.getState().teams["sq-1"]!.name).toBe("Refactor Crew")
  })

  it("refuses an empty name, which would leave an unclickable rail row", async () => {
    render(<SquadDetailPanel squadId="sq-1" />)
    const input = screen.getByLabelText(/name/i)
    await userEvent.clear(input)
    fireEvent.blur(input)
    expect(useAgentTeamStore.getState().teams["sq-1"]!.name).toBe("Research")
  })

  it("lists members name-sorted and leaves other Squads' members out", () => {
    seed(
      [squad()],
      [
        member({ id: "b", name: "Bravo" }),
        member({ id: "a", name: "Alpha" }),
        member({ id: "x", name: "Zulu", teamId: "sq-2" }),
      ]
    )
    render(<SquadDetailPanel squadId="sq-1" />)
    const rows = screen.getAllByTestId("squad-detail-member")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent("Alpha")
  })

  it("says the roster is empty rather than rendering an empty box", () => {
    render(<SquadDetailPanel squadId="sq-1" />)
    expect(screen.getByTestId("squad-detail-empty-roster")).toBeInTheDocument()
  })

  it("asks before deleting, then reports the deletion so the caller can move on", async () => {
    const onDeleted = jest.fn()
    render(<SquadDetailPanel squadId="sq-1" onDeleted={onDeleted} />)
    await userEvent.click(screen.getByTestId("squad-delete"))
    // Nothing gone yet — the confirm is the point.
    expect(useAgentTeamStore.getState().teams["sq-1"]).toBeDefined()
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }))
    expect(useAgentTeamStore.getState().teams["sq-1"]).toBeUndefined()
    expect(onDeleted).toHaveBeenCalledWith("sq-1")
  })

  it("says so when the Squad went away under an open pane", () => {
    seed([])
    render(<SquadDetailPanel squadId="sq-1" />)
    expect(screen.getByTestId("squad-detail-missing")).toBeInTheDocument()
  })
})
