/** @jest-environment jsdom */

// `/squads` on a phone: the list as the page, then one Squad full-screen. The
// Squad view itself (`SquadDetailView`) has its own suite; these cases are
// about which level is showing and how the phone moves between them.

import { render, screen, waitFor } from "@testing-library/react"
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
jest.mock("@/components/agent/workspace/tasks", () => ({
  AgentTeamTasks: ({ teamId }: { teamId: string }) => <div data-testid="task-board">{teamId}</div>,
}))
jest.mock("@/components/agent/workspace/team-run-controls", () => ({
  TeamRunControls: ({ status }: { status: string }) => (
    <div data-testid="run-controls">{status}</div>
  ),
}))
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => 0 }))
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
const setRunStatus = jest.fn()
const setTab = jest.fn()

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

beforeEach(() => {
  jest.clearAllMocks()
  usePendingGatesStore.setState({ gates: [] } as never)
  useProjectStore.setState({ activeProjectId: null } as never)
  seed([squad("a", "Alpha"), squad("b", "Bravo")])
})

describe("SquadsMobileBody, the list", () => {
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

  /** Over the wallpaper the rows share one surface rather than a card each. */
  it("groups the rows on the page", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getByTestId("squad-fleet-rail")).toHaveAttribute("data-variant", "page")
  })

  /** A Board with no Squad selected rendered the list a second time. */
  it("offers the list and every Squad's runs, and no Squad-less board", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Squads",
      "All runs",
    ])
  })

  it("lands a board link with no Squad on the list", () => {
    render(<SquadsMobileBody route={route({ tab: "board" })} />)
    expect(screen.getByTestId("squads-mobile-tab-squads")).toHaveAttribute("data-state", "active")
    expect(screen.queryByTestId("task-board")).not.toBeInTheDocument()
  })

  it("shows every Squad's runs in the compact cockpit", () => {
    render(<SquadsMobileBody route={route({ tab: "runs" })} />)
    // The canonical run cockpit, pinned to Squad runs (ADR-0169).
    const panel = screen.getByTestId("agent-runs-panel")
    expect(panel).toHaveAttribute("data-embedded", "true")
    expect(panel).toHaveAttribute("data-kind", "team")
    expect(panel).toHaveAttribute("data-team", "")
  })

  /** Same inert-chip fix as the wide pane: the phone writes `?status=` too. */
  it("gives the run chips a URL to write to", async () => {
    render(<SquadsMobileBody route={route({ tab: "runs", runStatus: "finished" })} />)
    expect(screen.getByTestId("agent-runs-panel")).toHaveAttribute("data-status", "finished")

    await userEvent.click(screen.getByTestId("agent-runs-status-chip"))
    expect(setRunStatus).toHaveBeenCalledWith("failed")
  })

  it("reports a tab change instead of owning it", async () => {
    const user = userEvent.setup()
    render(<SquadsMobileBody route={route()} />)
    screen.getByRole("tab", { name: "Squads" }).focus()
    await user.keyboard("{ArrowRight}")
    expect(setTab).toHaveBeenCalledWith("runs")
  })

  it("opens a Squad from its row", async () => {
    render(<SquadsMobileBody route={route()} />)
    await userEvent.click(screen.getAllByTestId("squad-fleet-row")[1]!)
    expect(setSelectedId).toHaveBeenCalledWith("b")
  })
})

describe("SquadsMobileBody, one Squad", () => {
  /**
   * The selection is a URL param, so a link opens the Squad directly. It used
   * to open a drawer over the list, whose Runs and Board tabs stayed scoped to
   * a Squad nothing on screen named.
   */
  it("replaces the list with the Squad's own view", () => {
    render(<SquadsMobileBody route={route({ selectedId: "b" })} />)
    expect(screen.getByTestId("squad-fleet-inspector")).toHaveTextContent("Bravo")
    expect(screen.queryByTestId("squads-mobile-tab-squads")).not.toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("lands on the overview and keeps the Squad's tabs", () => {
    render(<SquadsMobileBody route={route({ selectedId: "b" })} />)
    expect(screen.getByTestId("squad-detail-tab-overview")).toHaveAttribute(
      "data-state",
      "active"
    )
    expect(screen.getByTestId("squad-detail-tab-runs")).toBeInTheDocument()
    expect(screen.getByTestId("squad-detail-tab-board")).toBeInTheDocument()
  })

  it("goes back to the list", async () => {
    render(<SquadsMobileBody route={route({ selectedId: "b" })} />)
    await userEvent.click(screen.getByRole("button", { name: "Back to Squads" }))
    expect(setSelectedId).toHaveBeenCalledWith(undefined)
  })

  it("pins the compact cockpit to the Squad", () => {
    render(<SquadsMobileBody route={route({ selectedId: "b", tab: "runs" })} />)
    expect(screen.getByTestId("agent-runs-panel")).toHaveAttribute("data-team", "b")
  })

  it("shows the chosen Squad's board", () => {
    render(<SquadsMobileBody route={route({ tab: "board", selectedId: "a" })} />)
    expect(screen.getByTestId("task-board")).toHaveTextContent("a")
  })

  it("links configuration to the Squad's panel in Settings", () => {
    render(<SquadsMobileBody route={route({ selectedId: "b" })} />)
    expect(screen.getByTestId("squad-fleet-configure")).toHaveAttribute(
      "href",
      expect.stringContaining("squadTab=squad%3Ab")
    )
  })

  /** A stale link says so, and the way back clears the dead `?id=`. */
  it("says a Squad is gone and offers the way back to all of them", async () => {
    render(<SquadsMobileBody route={route({ selectedId: "gone" })} />)
    expect(screen.getByTestId("squads-mobile-missing")).toHaveTextContent("Squad unavailable")
    expect(screen.getByTestId("mobile-spot-icon-agent-teams")).toBeInTheDocument()
    expect(screen.queryByTestId("squad-fleet-row")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Show all Squads" }))
    expect(setSelectedId).toHaveBeenCalledWith(undefined)
  })
})

describe("creation", () => {
  it("offers a way to make the first Squad without leaving for Settings", async () => {
    seed([])
    render(<SquadsMobileBody route={route()} />)
    await userEvent.click(screen.getByTestId("squad-fleet-create"))
    expect(createSquadMock).toHaveBeenCalled()
    // And lands on it, rather than leaving a new row to go looking for.
    await waitFor(() => expect(setSelectedId).toHaveBeenCalledWith("new"))
  })

  /** Once there are rows, "New Squad" lives in the header, always in reach. */
  it("creates from the header", async () => {
    render(<SquadsMobileBody route={route()} />)
    await userEvent.click(screen.getByRole("button", { name: "New Squad" }))
    expect(createSquadMock).toHaveBeenCalled()
    await waitFor(() => expect(setSelectedId).toHaveBeenCalledWith("new"))
  })

  it("composes a Squad from an objective and opens it", async () => {
    render(<SquadsMobileBody route={route()} />)
    await userEvent.click(screen.getByRole("button", { name: "Compose from an objective" }))
    await userEvent.click(screen.getByTestId("compose-stub"))
    expect(setSelectedId).toHaveBeenCalledWith("composed")
  })

  it("still points at Settings for everything a phone cannot author", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getByTestId("squads-mobile-manage")).toHaveAttribute(
      "href",
      expect.stringContaining("section=squads")
    )
  })
})
