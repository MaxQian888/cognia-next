/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TaskBoardCard } from "./task-card"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeamTask } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key
    return t
  },
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("@cognia/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    createLogger: () => ({ ...child, child: () => child }),
    logger: { ...child, child: () => child },
    loggers: {
      agent: { ...child, child: () => child },
      plugin: { ...child, child: () => child },
      workflow: { ...child, child: () => child },
      db: { ...child, child: () => child },
    },
  }
})

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}))

// useSortable needs a live DndContext — stub it (drag behavior is covered by
// board-model's resolveDrop tests + the board's synthetic-drop tests).
const sortableState = {
  attributes: {},
  listeners: {},
  setNodeRef: jest.fn(),
  transform: null,
  transition: undefined,
  isDragging: false,
}
jest.mock("@dnd-kit/sortable", () => ({
  useSortable: jest.fn(() => sortableState),
}))

let slotPoints: Array<{ point: string; context?: Record<string, unknown> }> = []
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: (props: { point: string; context?: Record<string, unknown> }) => {
    slotPoints.push(props)
    return <div data-testid={`slot-${props.point}`} />
  },
}))

jest.mock("../task-comments", () => ({
  TaskComments: () => <div data-testid="task-comments" />,
}))

const task = (overrides: Partial<AgentTeamTask> = {}): AgentTeamTask =>
  ({
    id: "task-1",
    teamId: "t1",
    title: "Ship the board",
    description: "",
    status: "pending",
    priority: "high",
    dependencies: [],
    tags: ["ui", "kanban"],
    createdAt: new Date(),
    order: 0,
    ...overrides,
  }) as AgentTeamTask

const renderCard = (props: Partial<Parameters<typeof TaskBoardCard>[0]> = {}) =>
  render(
    <TooltipProvider>
      <TaskBoardCard
        task={task()}
        assigneeName="Worker One"
        lock={{ locked: false, blocking: [] }}
        {...props}
      />
    </TooltipProvider>
  )

beforeEach(() => {
  slotPoints = []
  useAgentTeamStore.getState().reset()
  jest.clearAllMocks()
})

describe("TaskBoardCard", () => {
  it("renders title, priority, assignee and tags", () => {
    renderCard()
    expect(screen.getByText("Ship the board")).toBeInTheDocument()
    expect(screen.getByText("high")).toBeInTheDocument()
    expect(screen.getByText("Worker One")).toBeInTheDocument()
    expect(screen.getByText("ui")).toBeInTheDocument()
    expect(screen.getByText("kanban")).toBeInTheDocument()
  })

  it.each(["critical", "high", "low", "background", "normal"] as const)(
    "renders the %s priority accent without crashing",
    (priority) => {
      renderCard({ task: task({ priority }) })
      expect(screen.getByTestId("board-card-task-1")).toBeInTheDocument()
    }
  )

  it("shows the dependency-lock badge only when locked", () => {
    renderCard({ lock: { locked: true, blocking: [{ id: "dep-1", title: "Upstream" }] } })
    expect(screen.getByTestId("board-card-task-1-lock")).toBeInTheDocument()
  })

  it("hides the lock badge when unlocked", () => {
    renderCard()
    expect(screen.queryByTestId("board-card-task-1-lock")).not.toBeInTheDocument()
  })

  it("mounts the agent.team.task.actions slot with the task context in the menu", async () => {
    const user = userEvent.setup()
    renderCard()
    await user.click(screen.getByTestId("board-card-task-1-menu"))
    const slot = slotPoints.find((s) => s.point === "agent.team.task.actions")
    expect(slot?.context).toEqual({
      teamId: "t1",
      taskId: "task-1",
      status: "pending",
      assignedTo: undefined,
      tags: ["ui", "kanban"],
    })
  })

  it("deletes the task through the confirm dialog", async () => {
    const user = userEvent.setup()
    const state = useAgentTeamStore.getState()
    const team = state.createTeam({ name: "T", task: "t" })
    const created = state.createTask({ teamId: team.id, title: "X", description: "" })
    renderCard({ task: { ...task(), id: created.id, teamId: team.id } })

    await user.click(screen.getByTestId(`board-card-${created.id}-menu`))
    await user.click(await screen.findByTestId(`board-card-${created.id}-delete`))
    // Confirm in the AlertDialog.
    await user.click(await screen.findByText("delete"))
    expect(useAgentTeamStore.getState().tasks[created.id]).toBeUndefined()
  })

  it("expands the comment thread on toggle", async () => {
    const user = userEvent.setup()
    renderCard()
    expect(screen.queryByTestId("task-comments")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("board-card-task-1-comments"))
    expect(screen.getByTestId("task-comments")).toBeInTheDocument()
  })
})
