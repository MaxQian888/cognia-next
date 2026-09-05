/** @jest-environment jsdom */

// The wide-pane console. Triage, workspace scope and narrowing moved into
// `useSquadFleet` and are tested there, against the store rather than through
// two layers of rendering. What is left here is the frame: which panes exist,
// which tab is showing, and where the header sends you.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"

import { SquadFleetConsole } from "./squad-fleet-console"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { AgentTeam, AgentTeammate, TeamStatus } from "@/types/agent/agent-team"
import type { SquadRouteState } from "@/hooks/squads/use-squad-route-state"

// Both are surfaces of their own with live Dexie queries. This suite is about
// the fleet frame around them.
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
// The board is `AgentTeamTasks`, its own surface with its own suite.
jest.mock("@/components/agent/workspace/tasks", () => ({
  AgentTeamTasks: ({ teamId }: { teamId: string }) => <div data-testid="task-board">{teamId}</div>,
}))
jest.mock("@/components/agent/workspace/team-run-controls", () => ({
  TeamRunControls: ({ status }: { status: string }) => (
    <div data-testid="run-controls">{status}</div>
  ),
}))
// `useSquadFleet` asks Dexie whether the mirror holds anything, to tell "not
// loaded yet" from "none". Answering 0 keeps every case here on the loaded
// path. The loading path is the hook's own case.
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => 0 }))

const createSquadMock = jest.fn(async () => ({ id: "new" }))
jest.mock("@/hooks/squads/use-create-squad", () => ({
  useCreateSquad: () => createSquadMock,
}))

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
    tasks: {} as never,
  })
}

const setSelectedId = jest.fn()
const setRunId = jest.fn()
const setTab = jest.fn()

/**
 * The URL state as a plain object. The route owns the hook, so a console case
 * poses the four answers directly instead of mocking `next/navigation`.
 */
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

/** The header's action buttons carry tooltips, mounted app-wide in the layout. */
function renderConsole(state: SquadRouteState) {
  return render(
    <TooltipProvider>
      <SquadFleetConsole route={state} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  usePendingGatesStore.setState({ gates: [] } as never)
  fleetSource = "none"
  useProjectStore.setState({ activeProjectId: null } as never)
  seed([squad("a", "Alpha"), squad("b", "Bravo")])
})

describe("SquadFleetConsole", () => {
  it("renders the rail as a real pane, never behind a Sheet glyph", () => {
    renderConsole(route())
    expect(screen.getAllByTestId("squad-fleet-row")).toHaveLength(2)
  })

  /**
   * ADR-0169: the Runs tab IS the canonical run cockpit, embedded and pinned
   * to Squad runs. Without a selection it lists every Squad's runs.
   */
  it("shows the unified run cockpit without a selection, and without a second title", () => {
    renderConsole(route())
    const panel = screen.getByTestId("agent-runs-panel")
    expect(panel).toHaveAttribute("data-embedded", "true")
    expect(panel).toHaveAttribute("data-kind", "team")
    expect(panel).toHaveAttribute("data-team", "")
    expect(screen.queryByTestId("squad-fleet-inspector")).not.toBeInTheDocument()
  })

  it("opens the inspector and pins the cockpit to the selected Squad's runs", () => {
    renderConsole(route({ selectedId: "b", runId: "execution:team:run_9" }))
    expect(screen.getByTestId("squad-fleet-inspector")).toBeInTheDocument()
    const panel = screen.getByTestId("agent-runs-panel")
    expect(panel).toHaveAttribute("data-team", "b")
    // `?run=` shares the `/agent-runs` id space, so a card's deep link lands here too.
    expect(panel).toHaveAttribute("data-run", "execution:team:run_9")
  })

  it("sends configuration to Settings rather than growing a second editor", () => {
    // One place per question: this page answers "what is running".
    renderConsole(route({ selectedId: "b" }))
    const link = screen.getByTestId("squad-fleet-configure")
    expect(link).toHaveAttribute("href", expect.stringContaining("section=squads"))
    expect(link).toHaveAttribute("href", expect.stringContaining("squadTab=squad%3Ab"))
  })

  it("selects a Squad, and deselects when the same row is clicked again", async () => {
    const { unmount } = renderConsole(route())
    await userEvent.click(screen.getAllByTestId("squad-fleet-row")[0]!)
    expect(setSelectedId).toHaveBeenCalledWith("a")
    unmount()

    renderConsole(route({ selectedId: "a" }))
    await userEvent.click(screen.getAllByTestId("squad-fleet-row")[0]!)
    expect(setSelectedId).toHaveBeenLastCalledWith(undefined)
  })

  /**
   * Narrowing is about the list, not about what you were reading. Deriving the
   * inspector from the narrowed rows would blank the detail of the Squad you
   * had open the moment you typed into the search box.
   */
  it("keeps the inspector open on a Squad the filter has hidden", () => {
    renderConsole(route({ selectedId: "b", query: "Alpha", narrowed: true }))
    expect(screen.queryAllByTestId("squad-fleet-row")).toHaveLength(1)
    expect(screen.getByTestId("squad-fleet-inspector")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runs-panel")).toHaveAttribute("data-team", "b")
  })
})

describe("SquadFleetConsole tabs", () => {
  /**
   * `squads` is the phone's tab. Asking for it here, from a shared link or
   * after a resize, must not select a tab with no trigger and no content.
   */
  it("resolves the phone-only tab to the runs console", () => {
    renderConsole(route({ tab: "squads" }))
    expect(screen.getByTestId("squad-fleet-tab-runs")).toHaveAttribute("data-state", "active")
    expect(screen.queryByTestId("squad-fleet-tab-squads")).not.toBeInTheDocument()
  })

  it("opens on the runs console, because the rail is already on screen", () => {
    renderConsole(route())
    expect(screen.getByTestId("squad-fleet-tab-runs")).toHaveAttribute("data-state", "active")
  })

  it("reports a tab change instead of owning it", async () => {
    const user = userEvent.setup()
    renderConsole(route())
    // Driven from the keyboard: Radix Tabs activates on arrow-key focus with
    // its default `activationMode="automatic"`, and that path exercises the
    // same `onValueChange` a click does while being the one a keyboard user
    // actually takes.
    screen.getByRole("tab", { name: "Runs" }).focus()
    await user.keyboard("{ArrowRight}")
    expect(setTab).toHaveBeenCalledWith("board")
  })

  it("offers the board only once a Squad is chosen", () => {
    renderConsole(route({ tab: "board" }))
    expect(screen.getByTestId("squad-fleet-board-unselected")).toBeInTheDocument()
  })

  it("shows the chosen Squad's board", () => {
    renderConsole(route({ tab: "board", selectedId: "a" }))
    expect(screen.getByTestId("task-board")).toHaveTextContent("a")
  })
})

describe("SquadFleetConsole host activity link", () => {
  /**
   * `/fleet` declares `standalone: "hidden"`, so on an unpaired browser the
   * route does not exist and the link would be a dead end.
   */
  it("offers the host fleet once a host is reachable", () => {
    fleetSource = "companion"
    renderConsole(route())
    expect(screen.getByTestId("squad-fleet-host-activity")).toBeInTheDocument()
  })

  it("hides it in an unpaired browser", () => {
    fleetSource = "none"
    renderConsole(route())
    expect(screen.queryByTestId("squad-fleet-host-activity")).not.toBeInTheDocument()
  })
})

describe("SquadFleetConsole creation", () => {
  /**
   * The empty state used to name Settings and leave you to go find it, which
   * is the one moment a fleet console has nothing else to offer.
   */
  it("offers a way to make the first Squad, and follows what it made", async () => {
    seed([])
    renderConsole(route())
    await userEvent.click(screen.getByTestId("squad-fleet-create"))
    expect(createSquadMock).toHaveBeenCalled()
    await screen.findByTestId("squad-fleet-create")
    expect(setSelectedId).toHaveBeenCalledWith("new")
  })
})
