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

jest.mock("@/lib/ai/agent/agent-team", () => ({ agentTeamManager: { start: jest.fn() } }))
jest.mock("@/lib/ai/agent/agent-team-runtime", () => ({ abortTeam: jest.fn() }))

jest.mock("@/components/agent/workspace/overview", () => ({
  AgentTeamOverview: () => <div data-testid="overview-section" />,
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
jest.mock("@/components/agent/team/gate-modals-host", () => ({
  GateModalsHost: () => null,
}))

describe("<TeamWorkspaceMobile />", () => {
  beforeEach(() => {
    teamId = "t1"
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

  it("shows an empty state with a back action when the team is missing", async () => {
    teamId = "missing"
    const user = userEvent.setup()
    render(<TeamWorkspaceMobile />)
    expect(screen.getByTestId("empty-state")).toBeInTheDocument()
    await user.click(screen.getByTestId("mobile-team-back"))
    expect(push).toHaveBeenCalledWith("/discover")
  })
})
