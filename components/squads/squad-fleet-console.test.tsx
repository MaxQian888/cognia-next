/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import { SquadFleetConsole } from "./squad-fleet-console"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { AgentTeam, AgentTeammate, TeamStatus } from "@/types/agent/agent-team"

// Both are surfaces of their own with live Dexie queries; this suite is about
// the fleet frame around them.
jest.mock("@/components/agent/team/command-center", () => ({
  AgentTeamCommandCenter: ({ heading }: { heading?: boolean }) => (
    <div data-testid="command-center" data-heading={String(heading)} />
  ),
}))
jest.mock("@/components/agent/team/runs-list", () => ({
  TeamRunsList: ({ teamId }: { teamId: string }) => <div data-testid="runs-list">{teamId}</div>,
}))
// The board is `AgentTeamTasks`, its own surface with its own suite.
jest.mock("@/components/agent/workspace/tasks", () => ({
  AgentTeamTasks: ({ teamId }: { teamId: string }) => <div data-testid="task-board">{teamId}</div>,
}))
jest.mock("@/components/agent/workspace/team-run-controls", () => ({
  TeamRunControls: ({ status }: { status: string }) => (
    <div data-testid="run-controls">{status}</div>
  ),
}))
let isMobile = false
jest.mock("@/hooks/ui", () => ({ useIsMobile: () => isMobile }))

let fleetSource: "tauri" | "companion" | "none" = "none"
jest.mock("@/hooks/fleet/use-fleet-snapshot", () => ({
  useFleetSnapshot: () => ({ source: fleetSource, snapshot: { sessions: [] } }),
}))
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    start: jest.fn(async () => {}),
    pause: jest.fn(async () => {}),
    resume: jest.fn(async () => {}),
    shutdown: jest.fn(async () => {}),
  },
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

function gates(entries: Array<{ teamId?: string; status?: "open" | "interrupted" }>) {
  usePendingGatesStore.setState({
    gates: entries.map((entry, i) => ({
      key: { scope: "team", id: `g${i}` },
      gateType: "plan",
      title: "Approve the plan",
      openedAt: 0,
      status: entry.status ?? "open",
      ...(entry.teamId ? { teamId: entry.teamId } : {}),
    })) as never,
  })
}

beforeEach(() => {
  gates([])
  isMobile = false
  fleetSource = "none"
  useProjectStore.setState({ activeProjectId: null } as never)
})

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

  it("shows the command centre without a selection, and without a second title", () => {
    // The page header already says what this is.
    render(<SquadFleetConsole onSelect={jest.fn()} />)
    expect(screen.getByTestId("command-center")).toHaveAttribute("data-heading", "false")
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

describe("SquadFleetConsole triage and scope", () => {
  /**
   * A fleet view is read to find what needs YOU. A Squad blocked on an approval
   * is the one row that will not move until it is answered, and sorting it
   * below an alphabetically earlier idle Squad buries the only actionable thing
   * on the page. `PendingGate.teamId` has carried this all along.
   */
  it("puts a Squad waiting on a human above a working one", () => {
    seed([squad("a", "Alpha", "executing"), squad("z", "Zulu")])
    gates([{ teamId: "z" }])
    render(<SquadFleetConsole onSelect={() => {}} />)
    const rows = screen.getAllByTestId("squad-fleet-row")
    expect(rows[0]).toHaveTextContent("Zulu")
    expect(rows[0]).toHaveTextContent("Needs you")
  })

  /** A restored-but-dead gate is Dismiss-only and answers nothing. */
  it("ignores an interrupted gate", () => {
    seed([squad("a", "Alpha"), squad("z", "Zulu")])
    gates([{ teamId: "z", status: "interrupted" }])
    render(<SquadFleetConsole onSelect={() => {}} />)
    const rows = screen.getAllByTestId("squad-fleet-row")
    expect(rows[0]).toHaveTextContent("Alpha")
    expect(screen.queryByTestId("squad-fleet-waiting")).not.toBeInTheDocument()
  })

  it("hides a Squad from another workspace and keeps an unscoped one", () => {
    seed([
      { ...squad("a", "Alpha"), projectId: "p1" } as AgentTeam,
      { ...squad("b", "Bravo"), projectId: "p2" } as AgentTeam,
      squad("c", "Charlie"),
    ])
    useProjectStore.setState({ activeProjectId: "p1" } as never)
    render(<SquadFleetConsole onSelect={() => {}} />)
    const names = screen.getAllByTestId("squad-fleet-row").map((r) => r.textContent)
    expect(names.some((n) => n?.includes("Alpha"))).toBe(true)
    expect(names.some((n) => n?.includes("Charlie"))).toBe(true)
    expect(names.some((n) => n?.includes("Bravo"))).toBe(false)
  })

  /**
   * The tab is a prop from `?tab=`, not local state. `FeaturePageShell` renders
   * its children through two different trees, a resizable pane set and a narrow
   * single column, and moving between them REMOUNTS the subtree, so a tab held
   * in `useState` here snaps back the first time the breakpoint resolves.
   */
  it("reports a tab change instead of owning it", async () => {
    const onTabChange = jest.fn()
    const user = userEvent.setup()
    render(<SquadFleetConsole onSelect={() => {}} onTabChange={onTabChange} />)
    // Driven from the keyboard: Radix Tabs activates on arrow-key focus with
    // its default `activationMode="automatic"`, and that path exercises the
    // same `onValueChange` a click does while being the one a keyboard user
    // actually takes.
    screen.getByRole("tab", { name: "Runs" }).focus()
    await user.keyboard("{ArrowRight}")
    expect(onTabChange).toHaveBeenCalledWith("board")
  })

  it("offers the board only once a Squad is chosen", () => {
    render(<SquadFleetConsole onSelect={() => {}} tab="board" />)
    expect(screen.getByTestId("squad-fleet-board-unselected")).toBeInTheDocument()
    expect(screen.queryByTestId("task-board")).not.toBeInTheDocument()
  })

  it("shows the chosen Squad's board and its run controls", () => {
    render(<SquadFleetConsole selectedId="a" onSelect={() => {}} tab="board" />)
    // A fleet console that says what every Squad is doing and cannot act on
    // any of it is half a console.
    expect(screen.getByTestId("run-controls")).toBeInTheDocument()
    expect(screen.getByTestId("task-board")).toHaveTextContent("a")
  })
})

describe("SquadFleetConsole host activity link", () => {
  // A secondary header action renders inside a Tooltip, whose provider is
  // mounted once in `app/layout.tsx` rather than per surface.
  const renderWithTooltips = (ui: React.ReactElement) =>
    render(<TooltipProvider>{ui}</TooltipProvider>)

  /**
   * `/fleet` is the live triage read of the HOST's sessions, where a parked
   * permission can be answered remotely. Its contract is `standalone: "hidden"`
   * and `companion: "remote"`, so offering it in an unpaired browser would be a
   * link to a route that is not there.
   */
  it("offers the host fleet once a host is reachable", () => {
    fleetSource = "companion"
    renderWithTooltips(<SquadFleetConsole onSelect={() => {}} />)
    expect(screen.getByTestId("squad-fleet-host-activity")).toHaveAttribute("href", "/fleet")
  })

  it("hides it in an unpaired browser", () => {
    fleetSource = "none"
    renderWithTooltips(<SquadFleetConsole onSelect={() => {}} />)
    expect(screen.queryByTestId("squad-fleet-host-activity")).toBeNull()
  })
})

describe("SquadFleetConsole on a phone", () => {
  beforeEach(() => {
    isMobile = true
  })

  /**
   * `FeaturePageShell` puts the left pane behind a Sheet on a narrow viewport,
   * which is right for `/issues`, whose rail is a filter and whose centre is
   * the content. Here the rail IS the content: a page called Squads that
   * answered "no durable runs match these filters" and hid every Squad behind
   * an unlabelled glyph was withholding the one thing a phone opened it for.
   */
  it("makes the Squad list a named tab rather than a Sheet behind a glyph", () => {
    render(<SquadFleetConsole onSelect={() => {}} tab="squads" />)
    expect(screen.getByTestId("squad-fleet-tab-squads")).toBeInTheDocument()
    expect(screen.getAllByTestId("squad-fleet-row").length).toBeGreaterThan(0)
  })

  /** Two doors to the same list is how a surface starts disagreeing with itself. */
  it("stops the shell offering the same panes as Sheets", () => {
    render(<SquadFleetConsole selectedId="a" onSelect={() => {}} tab="squads" />)
    expect(screen.queryByTestId("feature-shell-squads-left-trigger")).toBeNull()
    expect(screen.queryByTestId("feature-shell-squads-right-trigger")).toBeNull()
  })

  /** The list, and under it whatever the selection is about: one column. */
  it("puts the selected Squad's detail under the list", () => {
    render(<SquadFleetConsole selectedId="a" onSelect={() => {}} tab="squads" />)
    expect(screen.getByTestId("squad-fleet-inspector")).toBeInTheDocument()
  })

  /**
   * Landing a phone on "no durable runs match these filters" answered a
   * question nobody asked while withholding the one they did.
   */
  it("opens on the Squads when the URL names no tab", () => {
    render(<SquadFleetConsole onSelect={() => {}} />)
    expect(screen.getAllByTestId("squad-fleet-row").length).toBeGreaterThan(0)
  })

  it("offers no Squads tab on a wide pane", () => {
    isMobile = false
    render(<SquadFleetConsole onSelect={() => {}} />)
    expect(screen.queryByTestId("squad-fleet-tab-squads")).toBeNull()
  })

  /**
   * A `?tab=squads` link opened on a wide pane, or a resize past the
   * breakpoint, would otherwise select a tab with no trigger and no content.
   */
  it("resolves a phone-only tab to the runs console on a wide pane", () => {
    isMobile = false
    render(<SquadFleetConsole onSelect={() => {}} tab="squads" />)
    expect(screen.getByTestId("command-center")).toBeInTheDocument()
  })

  /** A wide pane already shows the list in its rail, so it opens on the runs. */
  it("still opens a wide pane on the runs console", () => {
    isMobile = false
    render(<SquadFleetConsole onSelect={() => {}} />)
    expect(screen.getByTestId("command-center")).toBeInTheDocument()
  })
})
