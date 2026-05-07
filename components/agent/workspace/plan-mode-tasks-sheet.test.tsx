import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanModeTasksSheet } from "./plan-mode-tasks-sheet"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { soloTeamId } from "@/lib/agent/plan-mode-bridge"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Stub the inner AgentTeamTasks — its rendering is covered by its own
// test file. The sheet test only proves we mount it with the right props.
jest.mock("./tasks", () => ({
  AgentTeamTasks: (props: { teamId: string; tasks: unknown[] }) => (
    <div data-testid="agent-team-tasks">
      team:{props.teamId} count:{props.tasks.length}
    </div>
  ),
}))

function reset() {
  useAgentTeamStore.setState({
    teams: {},
    teammates: {},
    tasks: {},
    messages: {},
    events: [],
    consensus: {},
    sharedMemory: {},
    delegations: {},
  })
}

describe("PlanModeTasksSheet", () => {
  beforeEach(reset)

  it("renders nothing when there are no tasks for the synthetic team", () => {
    const { container } = render(<PlanModeTasksSheet sessionId="s1" />)
    expect(container.firstChild).toBeNull()
  })

  it("shows a trigger labelled with the count when tasks exist", () => {
    const teamId = soloTeamId("s1")
    useAgentTeamStore.setState({
      teams: {
        [teamId]: {
          id: teamId,
          name: "x",
          description: "",
          task: "",
          status: "idle",
          config: useAgentTeamStore.getState().defaultConfig,
          leadId: "",
          teammateIds: [],
          taskIds: [],
          messageIds: [],
          progress: 0,
          totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          createdAt: new Date(),
        },
      },
    })
    useAgentTeamStore.getState().createTask({
      teamId,
      title: "T1",
      description: "T1 desc",
      priority: "normal",
    })
    render(<PlanModeTasksSheet sessionId="s1" />)
    const trigger = screen.getByTestId("plan-mode-tasks-trigger")
    expect(trigger).toBeInTheDocument()
    expect(trigger.getAttribute("aria-label")).toContain('"count":1')
  })

  it("opening the sheet renders AgentTeamTasks with the synthetic team id", async () => {
    const teamId = soloTeamId("s1")
    useAgentTeamStore.setState({
      teams: {
        [teamId]: {
          id: teamId,
          name: "x",
          description: "",
          task: "",
          status: "idle",
          config: useAgentTeamStore.getState().defaultConfig,
          leadId: "",
          teammateIds: [],
          taskIds: [],
          messageIds: [],
          progress: 0,
          totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          createdAt: new Date(),
        },
      },
    })
    useAgentTeamStore.getState().createTask({
      teamId,
      title: "T1",
      description: "T1 desc",
      priority: "normal",
    })
    const user = userEvent.setup()
    render(<PlanModeTasksSheet sessionId="s1" />)
    await user.click(screen.getByTestId("plan-mode-tasks-trigger"))
    expect(screen.getByTestId("agent-team-tasks").textContent).toContain(`team:${teamId}`)
    expect(screen.getByTestId("agent-team-tasks").textContent).toContain("count:1")
  })
})
