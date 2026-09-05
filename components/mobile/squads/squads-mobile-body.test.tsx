/** @jest-environment jsdom */

// `/squads` on a phone. These cases were the "on a phone" block of the console
// suite, testing a `useIsMobile()` branch inside the desktop component. They
// now test a body of its own, which is the point.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SquadsMobileBody } from "./squads-mobile-body"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { AgentTeam, TeamStatus } from "@/types/agent/agent-team"
import type { SquadRouteState } from "@/hooks/squads/use-squad-route-state"

jest.mock("@/hooks/squads/use-squad-readiness", () => ({
  useSquadReadiness: () => ({ ready: true, loading: false, blockers: [], evaluatedAt: 1 }),
}))
jest.mock("@/components/squads/squad-readiness-card", () => ({
  SquadReadinessCard: ({ squadId }: { squadId: string }) => (
    <div data-testid="squad-readiness" data-squad={squadId} />
  ),
}))
jest.mock("@/components/agent-runs/agent-runs-panel", () => ({
  AgentRunsPanel: ({
    teamId,
    embedded,
    filterKind,
    selectedId,
  }: {
    teamId?: string
    embedded?: boolean
    filterKind?: string
    selectedId?: string
  }) => (
    <div
      data-testid="agent-runs-panel"
      data-team={teamId ?? ""}
      data-embedded={String(Boolean(embedded))}
      data-kind={filterKind ?? "all"}
      data-run={selectedId ?? ""}
    />
  ),
}))
jest.mock("@/components/agent/workspace/tasks", () => ({
  AgentTeamTasks: ({ teamId }: { teamId: string }) => <div data-testid="task-board">{teamId}</div>,
}))
jest.mock("@/components/agent/workspace/team-run-controls", () => ({
  TeamRunControls: ({ status }: { status: string }) => (
    <div data-testid="run-controls">{status}</div>
  ),
}))
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => 0 }))

const createSquadMock = jest.fn(async () => ({ id: "new" }))
jest.mock("@/hooks/squads/use-create-squad", () => ({
  useCreateSquad: () => createSquadMock,
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

function seed(teams: AgentTeam[]) {
  useAgentTeamStore.setState({
    teams: Object.fromEntries(teams.map((t) => [t.id, t])) as never,
    teammates: {} as never,
    tasks: {} as never,
  })
}

const setSelectedId = jest.fn()
const setRunId = jest.fn()
const setTab = jest.fn()

function route(over: Partial<SquadRouteState> = {}): SquadRouteState {
  return {
    selectedId: undefined,
    runId: undefined,
    tab: undefined,
    query: "",
    filter: "all",
    narrowed: false,
    setSelectedId,
    setRunId,
    setTab,
    setQuery: jest.fn(),
    setFilter: jest.fn(),
    clearFilters: jest.fn(),
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  usePendingGatesStore.setState({ gates: [] } as never)
  useProjectStore.setState({ activeProjectId: null } as never)
  seed([squad("a", "Alpha"), squad("b", "Bravo")])
})

describe("SquadsMobileBody", () => {
  /**
   * The shell owns `data-bg-target` for every route that goes through it.
   * This body does not go through it, so without the mark the wallpaper has
   * nothing to paint against and the page renders on bare canvas.
   */
  it("marks itself as a wallpaper target, which the shell would otherwise do", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getByTestId("squads-mobile-body")).toHaveAttribute("data-bg-target", "chat")
  })

  /**
   * Landing a phone on "no durable runs match these filters" is the page
   * answering a question nobody asked while withholding the one they did.
   */
  it("opens on the Squads when the URL names no tab", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getByTestId("squads-mobile-tab-squads")).toHaveAttribute("data-state", "active")
    expect(screen.getAllByTestId("squad-fleet-row")).toHaveLength(2)
  })

  it("makes the Squad list a named tab rather than a Sheet behind a glyph", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getByTestId("squads-mobile-tab-squads")).toBeInTheDocument()
    expect(screen.getByTestId("squads-mobile-tab-runs")).toBeInTheDocument()
    expect(screen.getByTestId("squads-mobile-tab-board")).toBeInTheDocument()
  })

  it("honours a tab the URL does name", () => {
    render(<SquadsMobileBody route={route({ tab: "runs" })} />)
    // The canonical run cockpit, pinned to Squad runs (ADR-0169).
    const panel = screen.getByTestId("agent-runs-panel")
    expect(panel).toHaveAttribute("data-embedded", "true")
    expect(panel).toHaveAttribute("data-kind", "team")
  })

  it("reports a tab change instead of owning it", async () => {
    const user = userEvent.setup()
    render(<SquadsMobileBody route={route()} />)
    screen.getByRole("tab", { name: "Squads" }).focus()
    await user.keyboard("{ArrowRight}")
    expect(setTab).toHaveBeenCalledWith("runs")
  })
})

describe("detail", () => {
  /**
   * Deriving `open` from the URL selection IS the deep-link contract here.
   * `/devices` deliberately does not, because its selection is a persisted
   * store value that would re-pop the sheet on every return. Ours is a param.
   */
  it("opens the detail sheet from the URL selection", () => {
    render(<SquadsMobileBody route={route({ selectedId: "b" })} />)
    expect(screen.getByTestId("squad-fleet-inspector")).toBeInTheDocument()
  })

  /** Said, not hidden. A control that simply is not there reads as a bug. */
  it("names what configuration a phone does not get", () => {
    render(<SquadsMobileBody route={route({ selectedId: "b" })} />)
    expect(screen.getByTestId("squads-mobile-configure-note")).toBeInTheDocument()
  })

  it("leaves the sheet shut when nothing is selected", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.queryByTestId("squad-fleet-inspector")).not.toBeInTheDocument()
  })
})

describe("board", () => {
  it("shows the chosen Squad's board", () => {
    render(<SquadsMobileBody route={route({ tab: "board", selectedId: "a" })} />)
    expect(screen.getByTestId("task-board")).toHaveTextContent("a")
  })

  /**
   * The old empty state told a phone to pick a Squad from a rail that lived in
   * a different tab, which is a dead end with a helpful tone. The list IS
   * "pick a Squad", so it is what the board tab shows.
   */
  it("offers the list itself when nothing is selected, not a dead end", () => {
    render(<SquadsMobileBody route={route({ tab: "board" })} />)
    expect(screen.getAllByTestId("squad-fleet-row")).toHaveLength(2)
    expect(screen.queryByTestId("task-board")).not.toBeInTheDocument()
  })
})

describe("creation", () => {
  it("offers a way to make the first Squad without leaving for Settings", async () => {
    seed([])
    render(<SquadsMobileBody route={route()} />)
    await userEvent.click(screen.getByTestId("squad-fleet-create"))
    expect(createSquadMock).toHaveBeenCalled()
  })

  it("still points at Settings for everything a phone cannot author", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getByTestId("squads-mobile-manage")).toHaveAttribute(
      "href",
      expect.stringContaining("section=squads")
    )
  })
})
