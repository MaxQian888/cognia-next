/** @jest-environment jsdom */

// The wide-pane console. Triage, workspace scope and narrowing moved into
// `useSquadFleet` and are tested there, against the store rather than through
// two layers of rendering. One Squad's view is `SquadDetailView` with its own
// suite. What is left here is the frame: which panes exist, what the centre
// shows for each state of the URL, and where the header sends you.

import { render, screen, waitFor } from "@testing-library/react"
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
    statusGroup,
    onStatusGroup,
  }: {
    teamId?: string
    embedded?: boolean
    filterKind?: string
    selectedId?: string
    statusGroup?: string
    onStatusGroup?: (group: string) => void
  }) => (
    <div
      data-testid="agent-runs-panel"
      data-team={teamId ?? ""}
      data-embedded={String(Boolean(embedded))}
      data-kind={filterKind ?? "all"}
      data-run={selectedId ?? ""}
      data-status={statusGroup ?? ""}
    >
      {/* The chips were rendered with no setter behind them. This stands in
          for one, so a case can prove the click reaches the URL. */}
      <button
        type="button"
        data-testid="agent-runs-status-chip"
        onClick={() => onStatusGroup?.("failed")}
      />
    </div>
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
// The shell decides between side panes and overlay sheets by breakpoint.
let mockBreakpoint: "mobile" | "tablet" | "desktop" = "desktop"
jest.mock("@/hooks/ui", () => ({
  ...jest.requireActual("@/hooks/ui"),
  useBreakpoint: () => mockBreakpoint,
}))
// The dialog plans with a model. Here it only has to open and hand back an id.
jest.mock("@/components/agent/workspace/auto-compose-dialog", () => ({
  AutoComposeDialog: ({
    open,
    onComposed,
  }: {
    open: boolean
    onComposed: (teamId: string) => void
  }) =>
    open ? (
      <button type="button" data-testid="compose-stub" onClick={() => onComposed("composed")}>
        compose
      </button>
    ) : null,
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
jest.mock("@/lib/ai/agent/team/agent-team", () => ({
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
const setRunStatus = jest.fn()
const setTab = jest.fn()

/**
 * The URL state as a plain object. The route owns the hook, so a console case
 * poses the four answers directly instead of mocking `next/navigation`.
 */
function route(over: Partial<SquadRouteState> = {}): SquadRouteState {
  return {
    selectedId: undefined,
    runId: undefined,
    runStatus: "all",
    tab: undefined,
    query: "",
    filter: "all",
    narrowed: false,
    runHref: (runId) => `/squads?tab=runs&run=${encodeURIComponent(runId)}`,
    setSelectedId,
    setRunId,
    setRunStatus,
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
  mockBreakpoint = "desktop"
  usePendingGatesStore.setState({ gates: [] } as never)
  fleetSource = "none"
  useProjectStore.setState({ activeProjectId: null } as never)
  seed([squad("a", "Alpha"), squad("b", "Bravo")])
})

describe("SquadFleetConsole", () => {
  it("counts the fleet in the header", () => {
    renderConsole(route())
    expect(screen.getByText("2 Squads · idle")).toBeInTheDocument()
  })

  it("leaves the header uncounted when there is no Squad to count", () => {
    // It read "none working of 0 Squads" beside the empty state.
    seed([])
    renderConsole(route())
    expect(screen.queryByText(/0 Squads/)).not.toBeInTheDocument()
    expect(screen.getAllByTestId("mobile-spot-icon-agent-teams")).toHaveLength(2)
  })

  it("renders the rail as a real pane, never behind a Sheet glyph", () => {
    renderConsole(route())
    expect(screen.getAllByTestId("squad-fleet-row")).toHaveLength(2)
  })

  /** The rail scales with the window rather than keeping its first pixel width. */
  it("offers no collapse toggle that would pin the rail's width", () => {
    renderConsole(route())
    expect(screen.queryByRole("button", { name: /Hide Squad list/ })).not.toBeInTheDocument()
  })

  /**
   * Two panes, not three: a selected Squad heads its own view in the centre,
   * and nothing opens a fourth column on the right.
   */
  it("never opens a right-hand pane", () => {
    renderConsole(route({ selectedId: "b" }))
    expect(screen.queryByLabelText("Squad detail")).not.toBeInTheDocument()
    expect(screen.getAllByTestId("squad-detail-view")).toHaveLength(1)
  })
})

describe("SquadFleetConsole centre, nothing selected", () => {
  /**
   * ADR-0169: every Squad's runs are the canonical run cockpit, embedded and
   * pinned to Squad runs. The rail already lists the Squads themselves.
   */
  it("shows every Squad's runs in the unified cockpit", () => {
    renderConsole(route())
    expect(screen.getByTestId("squad-fleet-all-runs")).toHaveTextContent("Runs across every Squad")
    const panel = screen.getByTestId("agent-runs-panel")
    expect(panel).toHaveAttribute("data-embedded", "true")
    expect(panel).toHaveAttribute("data-kind", "team")
    expect(panel).toHaveAttribute("data-team", "")
    expect(screen.queryByTestId("squad-fleet-inspector")).not.toBeInTheDocument()
  })

  /** A Board with no Squad could only ever say "pick one", so there is none. */
  it("offers no Squad tabs, whatever tab the link named", () => {
    renderConsole(route({ tab: "board" }))
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-runs-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("task-board")).not.toBeInTheDocument()
  })

  /**
   * The chips carried a count and no setter: clickable, and inert. The status
   * bucket lives in `?status=` now, so the chip both reads and writes.
   */
  it("gives the run chips a URL to write to", async () => {
    renderConsole(route({ runStatus: "finished" }))
    expect(screen.getByTestId("agent-runs-panel")).toHaveAttribute("data-status", "finished")

    await userEvent.click(screen.getByTestId("agent-runs-status-chip"))
    expect(setRunStatus).toHaveBeenCalledWith("failed")
  })

  it("keeps an open run from a deep link", () => {
    renderConsole(route({ runId: "execution:team:run_9" }))
    expect(screen.getByTestId("agent-runs-panel")).toHaveAttribute(
      "data-run",
      "execution:team:run_9"
    )
  })
})

describe("SquadFleetConsole centre, a Squad selected", () => {
  it("lands on the Squad's overview, headed by its controls", () => {
    renderConsole(route({ selectedId: "b" }))
    expect(screen.getByTestId("squad-fleet-inspector")).toHaveTextContent("Bravo")
    expect(screen.getByTestId("squad-detail-tab-overview")).toHaveAttribute("data-state", "active")
    expect(screen.getByTestId("squad-overview")).toBeInTheDocument()
  })

  it("pins the cockpit to the selected Squad's runs", () => {
    renderConsole(route({ selectedId: "b", tab: "runs", runId: "execution:team:run_9" }))
    const panel = screen.getByTestId("agent-runs-panel")
    expect(panel).toHaveAttribute("data-team", "b")
    // `?run=` shares the `/agent-runs` id space, so a card's deep link lands here too.
    expect(panel).toHaveAttribute("data-run", "execution:team:run_9")
  })

  it("shows the chosen Squad's board", () => {
    renderConsole(route({ tab: "board", selectedId: "a" }))
    expect(screen.getByTestId("task-board")).toHaveTextContent("a")
  })

  /** `squads` is the phone's list tab; a selected Squad has no such tab. */
  it("resolves the phone-only tab to the overview", () => {
    renderConsole(route({ tab: "squads", selectedId: "a" }))
    expect(screen.getByTestId("squad-detail-tab-overview")).toHaveAttribute("data-state", "active")
  })

  it("sends configuration to Settings rather than growing a second editor", () => {
    // One place per question: this page answers "what is it doing".
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
   * view from the narrowed rows would blank the Squad you had open the moment
   * you typed into the search box.
   */
  it("keeps a Squad open after the filter has hidden its row", () => {
    renderConsole(route({ selectedId: "b", query: "Alpha", narrowed: true }))
    expect(screen.queryAllByTestId("squad-fleet-row")).toHaveLength(1)
    expect(screen.getByTestId("squad-fleet-inspector")).toHaveTextContent("Bravo")
  })

  /** A stale link used to leave a blank centre. */
  it("says a Squad is gone, and offers the way back to all of them", async () => {
    renderConsole(route({ selectedId: "gone" }))
    expect(screen.getByTestId("squad-fleet-missing")).toHaveTextContent("Squad unavailable")
    await userEvent.click(screen.getByRole("button", { name: "Show all Squads" }))
    expect(setSelectedId).toHaveBeenCalledWith(undefined)
  })
})

describe("SquadFleetConsole between md and lg", () => {
  /**
   * The shell moves the rail into a sheet below `lg`. Picking a Squad there is
   * the whole reason the sheet was opened, so the pick closes it and the
   * Squad's view is what the reader sees next.
   */
  it("closes the rail sheet on a pick", async () => {
    mockBreakpoint = "tablet"
    renderConsole(route())
    await userEvent.click(screen.getByRole("button", { name: /Squad list/ }))
    await userEvent.click((await screen.findAllByTestId("squad-fleet-row"))[0]!)
    expect(setSelectedId).toHaveBeenCalledWith("a")
    await waitFor(() => expect(screen.queryByTestId("squad-fleet-row")).not.toBeInTheDocument())
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

  it("links Settings for the library", () => {
    renderConsole(route())
    expect(screen.getByTestId("squad-fleet-manage")).toHaveAttribute(
      "href",
      expect.stringContaining("section=squads")
    )
  })
})

describe("SquadFleetConsole creation", () => {
  /** "New Squad" is in the header, always on screen, and follows what it made. */
  it("creates from the header and opens the new Squad", async () => {
    renderConsole(route())
    await userEvent.click(screen.getByTestId("squad-fleet-new"))
    expect(createSquadMock).toHaveBeenCalled()
    await waitFor(() => expect(setSelectedId).toHaveBeenCalledWith("new"))
  })

  /**
   * An empty workspace gets one full empty state, in the centre, with both
   * ways to make a Squad. The rail beside it only says the list is empty.
   */
  it("offers both ways to make the first Squad in the centre", async () => {
    seed([])
    renderConsole(route())
    expect(screen.getByTestId("squad-fleet-onboarding")).toBeInTheDocument()
    expect(screen.getByTestId("squad-fleet-empty-quiet")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-runs-panel")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("squad-fleet-create"))
    expect(createSquadMock).toHaveBeenCalled()
    await waitFor(() => expect(setSelectedId).toHaveBeenCalledWith("new"))
  })

  /** The auto-compose dialog was only reachable from Settings. */
  it("composes a Squad from an objective and opens it", async () => {
    renderConsole(route())
    await userEvent.click(screen.getByTestId("squad-fleet-compose"))
    await userEvent.click(screen.getByTestId("compose-stub"))
    expect(setSelectedId).toHaveBeenCalledWith("composed")
    expect(screen.queryByTestId("compose-stub")).not.toBeInTheDocument()
  })
})
