/** @jest-environment jsdom */

// The frame of one Squad's view: masthead, tabs, and what each tab is pinned
// to. The masthead, the overview and the run cockpit have suites of their own.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { PendingSquadReview } from "@/hooks/squads/use-pending-squad-reviews"
import type { SquadRouteState } from "@/hooks/squads/use-squad-route-state"
import type { SquadRunControl } from "@/hooks/squads/use-squad-run-control"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam, AgentTeamTask, AgentTeammate } from "@/types/agent/agent-team"

let mockReviews: PendingSquadReview[] = []
jest.mock("@/hooks/squads/use-pending-squad-reviews", () => ({
  usePendingSquadReviews: () => mockReviews,
}))
jest.mock("@/hooks/squads/use-squad-run-control", () => ({
  useSquadRunControl: (squadId: string) =>
    ({
      run: null,
      record: null,
      status: "idle",
      busy: false,
      remote: false,
      startDisabledReason: undefined,
      startOutcome: null,
      retryable: false,
      refusalMessage: undefined,
      refusalBlockers: [],
      canPause: false,
      canResume: false,
      canStop: false,
      start: jest.fn(),
      control: jest.fn(),
      squadId,
    }) as unknown as SquadRunControl,
}))
jest.mock("@/components/squads/squad-overview", () => ({
  SquadOverview: ({
    members,
    tasks,
    reviews,
    onOpenBoard,
  }: {
    members: unknown[]
    tasks: unknown[]
    reviews: unknown[]
    onOpenBoard: () => void
  }) => (
    <div
      data-testid="overview-stub"
      data-members={members.length}
      data-tasks={tasks.length}
      data-reviews={reviews.length}
    >
      <button type="button" onClick={onOpenBoard}>
        open board
      </button>
    </div>
  ),
}))
jest.mock("@/components/agent-runs/agent-runs-panel", () => ({
  AgentRunsPanel: ({
    teamId,
    selectedId,
    compact,
  }: {
    teamId?: string
    selectedId?: string
    compact?: boolean
  }) => (
    <div
      data-testid="agent-runs-panel"
      data-team={teamId ?? ""}
      data-run={selectedId ?? ""}
      data-compact={String(Boolean(compact))}
    />
  ),
}))
jest.mock("@/components/agent/workspace/tasks", () => ({
  AgentTeamTasks: ({ teamId, tasks }: { teamId: string; tasks: unknown[] }) => (
    <div data-testid="task-board" data-team={teamId} data-tasks={tasks.length} />
  ),
}))
jest.mock("@/components/agent/workspace/team-run-controls", () => ({
  TeamRunControls: () => <div data-testid="run-controls" />,
}))

import { SquadDetailView } from "./squad-detail-view"

const setTab = jest.fn()
function route(over: Partial<SquadRouteState> = {}): SquadRouteState {
  return {
    selectedId: "a",
    runId: undefined,
    runStatus: "all",
    tab: undefined,
    query: "",
    filter: "all",
    narrowed: false,
    runHref: (runId) => `/squads?id=a&tab=runs&run=${runId}`,
    setSelectedId: jest.fn(),
    setRunId: jest.fn(),
    setRunStatus: jest.fn(),
    setTab,
    setQuery: jest.fn(),
    setFilter: jest.fn(),
    clearFilters: jest.fn(),
    ...over,
  }
}

function seed() {
  useAgentTeamStore.setState({
    teams: {
      a: { id: "a", name: "Review Crew", status: "idle", config: {} } as unknown as AgentTeam,
      b: { id: "b", name: "Other", status: "idle", config: {} } as unknown as AgentTeam,
    },
    teammates: {
      m1: { id: "m1", teamId: "a", name: "Lead", role: "lead" } as AgentTeammate,
      m2: { id: "m2", teamId: "a", name: "Worker", role: "teammate" } as AgentTeammate,
      m3: { id: "m3", teamId: "b", name: "Elsewhere", role: "teammate" } as AgentTeammate,
    },
    tasks: {
      t1: { id: "t1", teamId: "a", status: "in_progress" } as AgentTeamTask,
      t2: { id: "t2", teamId: "a", status: "completed" } as AgentTeamTask,
      t3: { id: "t3", teamId: "b", status: "pending" } as AgentTeamTask,
    } as never,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockReviews = []
  seed()
})

it("heads the view with the Squad's masthead", () => {
  render(<SquadDetailView squadId="a" route={route()} tab="overview" />)
  expect(screen.getByTestId("squad-fleet-inspector")).toHaveTextContent("Review Crew")
  expect(screen.getByTestId("squad-fleet-inspector")).toHaveTextContent("2 members")
})

it("renders nothing for a Squad that no longer exists", () => {
  render(<SquadDetailView squadId="gone" route={route()} tab="overview" />)
  expect(screen.queryByTestId("squad-detail-view")).not.toBeInTheDocument()
})

it("scopes the overview to this Squad's members, tasks and reviews", () => {
  mockReviews = [
    { teamId: "a", interruptId: "i1" } as PendingSquadReview,
    { teamId: "b", interruptId: "i2" } as PendingSquadReview,
  ]
  render(<SquadDetailView squadId="a" route={route()} tab="overview" />)
  const overview = screen.getByTestId("overview-stub")
  expect(overview).toHaveAttribute("data-members", "2")
  expect(overview).toHaveAttribute("data-tasks", "2")
  expect(overview).toHaveAttribute("data-reviews", "1")
})

it("offers Overview, Runs and Board, and reports a switch to the URL", async () => {
  render(<SquadDetailView squadId="a" route={route()} tab="overview" />)
  expect(screen.getByTestId("squad-detail-tab-overview")).toHaveAttribute("data-state", "active")
  await userEvent.click(screen.getByTestId("squad-detail-tab-runs"))
  expect(setTab).toHaveBeenCalledWith("runs")
})

it("pins the run cockpit to this Squad and its open run", () => {
  render(<SquadDetailView squadId="a" route={route({ runId: "exec_1" })} tab="runs" />)
  const panel = screen.getByTestId("agent-runs-panel")
  expect(panel).toHaveAttribute("data-team", "a")
  expect(panel).toHaveAttribute("data-run", "exec_1")
  expect(panel).toHaveAttribute("data-compact", "false")
})

it("gives the board this Squad's tasks", () => {
  render(<SquadDetailView squadId="a" route={route()} tab="board" />)
  expect(screen.getByTestId("task-board")).toHaveAttribute("data-team", "a")
  expect(screen.getByTestId("task-board")).toHaveAttribute("data-tasks", "2")
})

it("opens the board from the overview", async () => {
  render(<SquadDetailView squadId="a" route={route()} tab="overview" />)
  await userEvent.click(screen.getByRole("button", { name: "open board" }))
  expect(setTab).toHaveBeenCalledWith("board")
})

describe("tab counts", () => {
  it("counts open reviews on Runs, where they are answered", () => {
    mockReviews = [{ teamId: "a", interruptId: "i1" } as PendingSquadReview]
    render(<SquadDetailView squadId="a" route={route()} tab="overview" />)
    expect(screen.getByLabelText("1 needs you")).toBeInTheDocument()
  })

  it("counts unfinished tasks on Board", () => {
    render(<SquadDetailView squadId="a" route={route()} tab="overview" />)
    expect(screen.getByLabelText("1 open task")).toBeInTheDocument()
  })
})

it("hands the compact cockpit to a phone, with a way back", async () => {
  const onBack = jest.fn()
  render(<SquadDetailView squadId="a" route={route()} tab="runs" onBack={onBack} compact />)
  expect(screen.getByTestId("agent-runs-panel")).toHaveAttribute("data-compact", "true")
  await userEvent.click(screen.getByTestId("squad-detail-back"))
  expect(onBack).toHaveBeenCalled()
})
