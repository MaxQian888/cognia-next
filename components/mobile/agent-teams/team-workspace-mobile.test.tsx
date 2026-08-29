/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TeamWorkspaceMobile } from "./team-workspace-mobile"

let teamId: string | null = "t1"
const push = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => teamId }),
  useRouter: () => ({ push }),
}))

jest.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }))

const fakeState = {
  teams: {
    t1: { id: "t1", name: "Team One", leadId: "a", executionReport: undefined },
  } as Record<string, unknown>,
  teammates: {},
  events: [] as unknown[],
  updateTeam: jest.fn(),
}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: typeof fakeState) => unknown) => selector(fakeState),
}))

const managerPause = jest.fn(async () => undefined)
const managerResume = jest.fn(async () => undefined)
const managerShutdown = jest.fn(async () => undefined)
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    start: jest.fn(),
    pause: (...a: unknown[]) => managerPause(...(a as [])),
    resume: (...a: unknown[]) => managerResume(...(a as [])),
    shutdown: (...a: unknown[]) => managerShutdown(...(a as [])),
  },
}))
jest.mock("@/lib/ai/agent/agent-team-runtime", () => ({ abortTeam: jest.fn() }))

// The stub exposes the run-control handlers as buttons: the point of the case
// below is that this surface passes them at all, not what the shared control
// block renders (that has its own suite).
jest.mock("@/components/agent/workspace/overview", () => ({
  AgentTeamOverview: (props: {
    onPause?: () => void
    onResume?: () => void
    onStop?: () => void
  }) => (
    <div data-testid="overview-section">
      <button data-testid="stub-pause" onClick={props.onPause} disabled={!props.onPause} />
      <button data-testid="stub-resume" onClick={props.onResume} disabled={!props.onResume} />
      <button data-testid="stub-stop" onClick={props.onStop} disabled={!props.onStop} />
    </div>
  ),
}))
jest.mock("@/components/agent/workspace/members", () => ({
  AgentTeamMembers: () => <div data-testid="members-section" />,
}))
jest.mock("@/components/agent/workspace/activity", () => ({
  AgentTeamActivity: () => <div data-testid="activity-section" />,
}))
jest.mock("@/components/agent/team/runs-list", () => ({
  TeamRunsList: () => <div data-testid="runs-list" />,
}))
// Rendered as a MARKER, not null: `app/layout.tsx` already mounts this host
// for every shell, so this page mounting its own copy is the defect the test
// below pins — and a null mock could never see it.
jest.mock("@/components/agent/team/gate-modals-host", () => ({
  GateModalsHost: () => <div data-testid="gate-modals-host" />,
}))
jest.mock("@/components/mobile/agent-teams/team-board-mobile", () => ({
  TeamBoardMobile: ({ teamId: id }: { teamId: string }) => (
    <div data-testid="board-section" data-team={id} />
  ),
}))

// Synced team-meta fallback (paired phone, empty local store).
let syncedMeta: { name: string } | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => syncedMeta,
}))
jest.mock("@/lib/db/agent-team-board", () => ({
  getAgentTeamBoardTeamRow: jest.fn(),
}))

describe("<TeamWorkspaceMobile />", () => {
  beforeEach(() => {
    teamId = "t1"
    syncedMeta = undefined
    push.mockClear()
  })

  it("renders the team name and the overview section by default", () => {
    render(<TeamWorkspaceMobile />)
    expect(screen.getByText("Team One")).toBeInTheDocument()
    expect(screen.getByTestId("overview-section")).toBeInTheDocument()
  })

  it("switches to the activity section (with run history)", async () => {
    const user = userEvent.setup()
    render(<TeamWorkspaceMobile />)
    await user.click(screen.getByTestId("mobile-team-tab-activity"))
    expect(screen.getByTestId("activity-section")).toBeInTheDocument()
    expect(screen.getByTestId("runs-list")).toBeInTheDocument()
  })

  it("switches to the synced board tab", async () => {
    const user = userEvent.setup()
    render(<TeamWorkspaceMobile />)
    await user.click(screen.getByTestId("mobile-team-tab-board"))
    expect(screen.getByTestId("board-section")).toBeInTheDocument()
  })

  // A paused team used to be a dead end here: the shared control block renders
  // Resume for a paused run, and this surface passed no handler for it.
  it("wires pause / resume / stop through to the team manager", async () => {
    const user = userEvent.setup()
    render(<TeamWorkspaceMobile />)
    await user.click(screen.getByTestId("stub-pause"))
    await user.click(screen.getByTestId("stub-resume"))
    await user.click(screen.getByTestId("stub-stop"))
    expect(managerPause).toHaveBeenCalledWith("t1")
    expect(managerResume).toHaveBeenCalledWith("t1")
    expect(managerShutdown).toHaveBeenCalledWith("t1")
  })

  it("does not mount a second GateModalsHost over the app-root one", () => {
    // Two hosts render two stacked Radix dialogs per pending gate, whose focus
    // traps fight; the loser is invisible but still trapping.
    render(<TeamWorkspaceMobile />)
    expect(screen.queryByTestId("gate-modals-host")).not.toBeInTheDocument()
  })

  it("shows an empty state with a back action when the team is missing", async () => {
    teamId = "missing"
    const user = userEvent.setup()
    render(<TeamWorkspaceMobile />)
    expect(screen.getByTestId("empty-state")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-spot-icon-agent-teams")).toBeInTheDocument()
    await user.click(screen.getByTestId("mobile-team-back"))
    expect(push).toHaveBeenCalledWith("/discover")
  })

  it("falls back to the synced board when the local store is empty but a meta row synced", () => {
    teamId = "remote-team"
    syncedMeta = { name: "Remote Alpha" }
    render(<TeamWorkspaceMobile />)
    expect(screen.getByText("Remote Alpha")).toBeInTheDocument()
    expect(screen.getByTestId("board-section")).toBeInTheDocument()
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument()
  })
})
