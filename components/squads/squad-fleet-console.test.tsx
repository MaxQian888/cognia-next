/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SquadFleetConsole } from "./squad-fleet-console"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam, AgentTeammate, TeamStatus } from "@/types/agent/agent-team"

// Both are surfaces of their own with live Dexie queries; this suite is about
// the fleet frame around them.
jest.mock("@/components/agent/team/command-center", () => ({
  AgentTeamCommandCenter: () => <div data-testid="command-center" />,
}))
jest.mock("@/components/agent/team/runs-list", () => ({
  TeamRunsList: ({ teamId }: { teamId: string }) => <div data-testid="runs-list">{teamId}</div>,
}))

function squad(id: string, name: string, status: TeamStatus = "idle"): AgentTeam {
  return {
    id,
    name,
    description: "",
    status,
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    config: {},
  } as unknown as AgentTeam
}

function seed(teams: AgentTeam[], members: AgentTeammate[] = []) {
  useAgentTeamStore.setState({
    teams: Object.fromEntries(teams.map((t) => [t.id, t])) as never,
    teammates: Object.fromEntries(members.map((m) => [m.id, m])) as never,
  })
}

beforeEach(() => seed([squad("a", "Alpha"), squad("b", "Bravo")]))

describe("SquadFleetConsole", () => {
  it("lists every Squad", () => {
    render(<SquadFleetConsole onSelect={jest.fn()} />)
    expect(screen.getAllByTestId("squad-fleet-row")).toHaveLength(2)
  })

  it("puts working Squads first — a fleet view is read for what is happening", () => {
    seed([squad("a", "Alpha"), squad("z", "Zulu", "executing")])
    render(<SquadFleetConsole onSelect={jest.fn()} />)
    const rows = screen.getAllByTestId("squad-fleet-row")
    expect(rows[0]).toHaveTextContent("Zulu")
  })

  it("shows the command centre without a selection", () => {
    render(<SquadFleetConsole onSelect={jest.fn()} />)
    expect(screen.getByTestId("command-center")).toBeInTheDocument()
    expect(screen.queryByTestId("squad-fleet-inspector")).not.toBeInTheDocument()
  })

  it("opens the inspector on the selected Squad's runs", () => {
    render(<SquadFleetConsole selectedId="b" onSelect={jest.fn()} />)
    expect(screen.getByTestId("squad-fleet-inspector")).toBeInTheDocument()
    expect(screen.getByTestId("runs-list")).toHaveTextContent("b")
  })

  it("sends configuration to Settings rather than growing a second editor", () => {
    // One place per question: this page answers "what is running".
    render(<SquadFleetConsole selectedId="b" onSelect={jest.fn()} />)
    const link = screen.getByTestId("squad-fleet-configure")
    expect(link).toHaveAttribute("href", expect.stringContaining("section=squads"))
    expect(link).toHaveAttribute("href", expect.stringContaining("squadTab=squad%3Ab"))
  })

  it("selects a Squad, and deselects when the same row is clicked again", async () => {
    const onSelect = jest.fn()
    const { rerender } = render(<SquadFleetConsole onSelect={onSelect} />)
    await userEvent.click(screen.getAllByTestId("squad-fleet-row")[0]!)
    expect(onSelect).toHaveBeenCalledWith("a")

    rerender(<SquadFleetConsole selectedId="a" onSelect={onSelect} />)
    await userEvent.click(screen.getAllByTestId("squad-fleet-row")[0]!)
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })

  it("says where Squads come from when there are none", () => {
    seed([])
    render(<SquadFleetConsole onSelect={jest.fn()} />)
    expect(screen.getByTestId("squad-fleet-empty")).toBeInTheDocument()
  })
})
