/**
 * @jest-environment jsdom
 *
 * Coverage for AgentTeamTasks:
 *   - empty state + show-form transition
 *   - task list rendering (title, status badge, priority, assignee, tags, error, result)
 *   - create-form: fill fields, save (handleCreate), cancel, disabled save on blank title
 *   - delete via AlertDialog
 */

import React from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentTeamTasks } from "./tasks"
import type { AgentTeamTask, AgentTeammate } from "@/types/agent/agent-team"

// ── motion mock ──────────────────────────────────────────────────────────────
const mockUseReducedMotion = jest.fn(() => true)
jest.mock("motion/react", () => ({
  motion: {
    div: ({
      children,
      initial: _initial,
      animate: _animate,
      transition: _transition,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & {
      initial?: unknown
      animate?: unknown
      transition?: unknown
    }) => <div {...props}>{children}</div>,
  },
  useReducedMotion: () => mockUseReducedMotion(),
}))

// ── i18n: return the raw key so assertions stay readable ─────────────────────
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// ── store: expose jest.fn() mocks so we can assert calls ─────────────────────
const createTaskMock = jest.fn()
const deleteTaskMock = jest.fn()
const setTasksViewMock = jest.fn()
// Mutable so individual tests can flip the persisted view or provide a team.
const mockStoreState: Record<string, unknown> = {}

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({
      createTask: createTaskMock,
      deleteTask: deleteTaskMock,
      setTasksView: setTasksViewMock,
      tasksView: "list",
      teams: {},
      ...mockStoreState,
    }),
}))

// ── twin catalog stub — the assignee-hint effect must not touch Dexie ────────
jest.mock("@/lib/ai/agent/team/twin-context", () => ({
  gatherTeamTwins: jest.fn(async () => []),
}))

// ── board stub — the kanban has its own suite; keep this one's graph light ───
jest.mock("./board/task-board", () => ({
  TaskBoard: () => <div data-testid="mock-task-board" />,
}))

// ── sonner ───────────────────────────────────────────────────────────────────
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: jest.fn() },
}))

// ── logging ──────────────────────────────────────────────────────────────────
jest.mock("@/lib/logging", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

// ── task-comments mock (avoids pulling the markdown ESM stack into this test) ─
jest.mock("./task-comments", () => ({
  TaskComments: ({ taskId }: { taskId: string }) => <div data-testid={`mock-comments-${taskId}`} />,
}))

// ── StatusBadge mock (avoids complex badge internals) ────────────────────────
jest.mock("@/components/status-badge", () => ({
  StatusBadge: ({ value, ...props }: { value: string; [key: string]: unknown }) => (
    <span {...props}>{value}</span>
  ),
}))

// ── Radix Select mock — avoids "value must not be empty string" error ─────────
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react") as typeof import("react")
  const Select = ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (v: string) => void
  }) => (
    <div data-testid="mock-select" data-value={value}>
      <button
        type="button"
        data-testid="mock-select-trigger"
        onClick={() => onValueChange?.("normal")}
      />
      {children}
    </div>
  )
  const SelectTrigger = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mock-select-trigger-inner">{children}</div>
  )
  const SelectValue = ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>
  const SelectContent = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  const SelectItem = ({ children, value }: { children?: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  )
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

// ─────────────────────────────────────────────────────────────────────────────

function makeTask(id: string, overrides: Partial<AgentTeamTask> = {}): AgentTeamTask {
  return {
    id,
    teamId: "t1",
    title: `Task ${id}`,
    description: `Desc ${id}`,
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    createdAt: new Date(),
    order: 0,
    ...overrides,
  }
}

function makeTeammate(id: string, name: string): AgentTeammate {
  return {
    id,
    teamId: "t1",
    name,
    description: "",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
  }
}

beforeEach(() => {
  createTaskMock.mockClear()
  deleteTaskMock.mockClear()
  setTasksViewMock.mockClear()
  toastSuccess.mockClear()
  for (const key of Object.keys(mockStoreState)) delete mockStoreState[key]
})

// ─────────────────────────────────────────────────────────────────────────────

describe("AgentTeamTasks", () => {
  // ── view toggle ────────────────────────────────────────────────────────────

  it("persists the view choice through setTasksView", () => {
    render(<AgentTeamTasks teamId="t1" tasks={[makeTask("a")]} teammates={[]} />)
    fireEvent.click(screen.getByTestId("tasks-view-board"))
    expect(setTasksViewMock).toHaveBeenCalledWith("board")
  })

  it("renders the board view when tasksView is board and the team exists", () => {
    mockStoreState.tasksView = "board"
    mockStoreState.teams = { t1: { id: "t1" } }
    render(<AgentTeamTasks teamId="t1" tasks={[makeTask("a")]} teammates={[]} />)
    expect(screen.getByTestId("mock-task-board")).toBeInTheDocument()
    expect(screen.queryByTestId("task-a")).not.toBeInTheDocument()
  })

  // ── empty state ────────────────────────────────────────────────────────────

  it("renders the empty state when no tasks are provided", () => {
    render(<AgentTeamTasks teamId="t1" tasks={[]} teammates={[]} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
    // 'Create task' button visible inside empty-state
    expect(screen.getByRole("button", { name: /createTask/i })).toBeInTheDocument()
    expect(screen.queryByTestId("task-create-form")).not.toBeInTheDocument()
  })

  it("shows the create form when the empty-state button is clicked", async () => {
    render(<AgentTeamTasks teamId="t1" tasks={[]} teammates={[]} />)
    await userEvent.click(screen.getByRole("button", { name: /createTask/i }))
    expect(screen.getByTestId("task-create-form")).toBeInTheDocument()
  })

  // ── task list rendering ────────────────────────────────────────────────────

  it("renders a card per task with status badge", () => {
    render(
      <AgentTeamTasks
        teamId="t1"
        tasks={[
          makeTask("a", { status: "completed", result: "ok" }),
          makeTask("b", { status: "failed", error: "boom" }),
        ]}
        teammates={[]}
      />
    )
    expect(screen.getByTestId("task-a")).toBeInTheDocument()
    expect(screen.getByTestId("task-b")).toBeInTheDocument()
    expect(screen.getByTestId("task-a-status").textContent).toContain("completed")
    expect(screen.getByTestId("task-b-status").textContent).toContain("failed")
  })

  it("shows error text for failed tasks and result text for completed tasks", () => {
    render(
      <AgentTeamTasks
        teamId="t1"
        tasks={[
          makeTask("a", { status: "completed", result: "all good" }),
          makeTask("b", { status: "failed", error: "kaboom" }),
        ]}
        teammates={[]}
      />
    )
    expect(screen.getByText("all good")).toBeInTheDocument()
    expect(screen.getByText("kaboom")).toBeInTheDocument()
  })

  it("renders task description when provided", () => {
    render(
      <AgentTeamTasks
        teamId="t1"
        tasks={[makeTask("d", { description: "Detailed work" })]}
        teammates={[]}
      />
    )
    expect(screen.getByText("Detailed work")).toBeInTheDocument()
  })

  it("renders priority badge for tasks with a priority", () => {
    render(
      <AgentTeamTasks
        teamId="t1"
        tasks={[makeTask("p", { priority: "critical" })]}
        teammates={[]}
      />
    )
    // tPriority("critical") → key "critical" via mock
    expect(screen.getByText("critical")).toBeInTheDocument()
  })

  it("renders assignee name when task has an assignedTo matching a teammate", () => {
    render(
      <AgentTeamTasks
        teamId="t1"
        tasks={[makeTask("a1", { assignedTo: "tm-1" })]}
        teammates={[makeTeammate("tm-1", "Alice")]}
      />
    )
    expect(screen.getByText("Alice")).toBeInTheDocument()
  })

  it("does not render assignee when task has no assignedTo", () => {
    render(
      <AgentTeamTasks
        teamId="t1"
        tasks={[makeTask("a2", { assignedTo: undefined })]}
        teammates={[makeTeammate("tm-1", "Alice")]}
      />
    )
    expect(screen.queryByText("Alice")).not.toBeInTheDocument()
  })

  it("renders tags when task has them", () => {
    render(
      <AgentTeamTasks
        teamId="t1"
        tasks={[makeTask("tg", { tags: ["alpha", "beta"] })]}
        teammates={[]}
      />
    )
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByText("beta")).toBeInTheDocument()
  })

  it("shows the tasks-count header when tasks list is non-empty", () => {
    render(<AgentTeamTasks teamId="t1" tasks={[makeTask("x")]} teammates={[]} />)
    expect(screen.getByTestId("workspace-tasks")).toBeInTheDocument()
    // t("tasksCount", { count: 1 }) → key "tasksCount" via mock
    expect(screen.getByText("tasksCount")).toBeInTheDocument()
  })

  // ── create form: open + fill + save (handleCreate) ──────────────────────────

  it("opens the create form via the header button when tasks already exist", async () => {
    render(<AgentTeamTasks teamId="t1" tasks={[makeTask("x")]} teammates={[]} />)
    // Header row create button (outline variant, not the empty-state one)
    const btns = screen.getAllByRole("button", { name: /createTask/i })
    await userEvent.click(btns[0])
    expect(screen.getByTestId("task-create-form")).toBeInTheDocument()
  })

  it("save button is disabled when title is empty", async () => {
    render(<AgentTeamTasks teamId="t1" tasks={[]} teammates={[]} />)
    await userEvent.click(screen.getByRole("button", { name: /createTask/i }))
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled()
  })

  it("save button becomes enabled after typing a title", async () => {
    render(<AgentTeamTasks teamId="t1" tasks={[]} teammates={[]} />)
    await userEvent.click(screen.getByRole("button", { name: /createTask/i }))
    // placeholder key is "taskTitlePlaceholder" (raw key returned by mock)
    const titleInput = screen.getByPlaceholderText("taskTitlePlaceholder")
    await userEvent.type(titleInput, "My task")
    expect(screen.getByRole("button", { name: /^save$/i })).not.toBeDisabled()
  })

  it("calls createTask with correct payload and hides the form on save", async () => {
    const tm = makeTeammate("tm-2", "Bob")
    render(<AgentTeamTasks teamId="t1" tasks={[]} teammates={[tm]} />)
    await userEvent.click(screen.getByRole("button", { name: /createTask/i }))

    await userEvent.type(screen.getByPlaceholderText("taskTitlePlaceholder"), "New task")
    await userEvent.type(screen.getByPlaceholderText("taskDescriptionPlaceholder"), "Some detail")

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }))

    expect(createTaskMock).toHaveBeenCalledTimes(1)
    const arg = createTaskMock.mock.calls[0][0]
    expect(arg.teamId).toBe("t1")
    expect(arg.title).toBe("New task")
    expect(arg.description).toBe("Some detail")
    // Form hidden after save
    expect(screen.queryByTestId("task-create-form")).not.toBeInTheDocument()
    // Toast fired
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it("uses title as description when description is left blank", async () => {
    render(<AgentTeamTasks teamId="t1" tasks={[]} teammates={[]} />)
    await userEvent.click(screen.getByRole("button", { name: /createTask/i }))
    await userEvent.type(screen.getByPlaceholderText("taskTitlePlaceholder"), "Only title")
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }))

    const arg = createTaskMock.mock.calls[0][0]
    expect(arg.description).toBe("Only title")
  })

  it("does not call createTask when title is only whitespace (guard branch)", async () => {
    render(<AgentTeamTasks teamId="t1" tasks={[]} teammates={[]} />)
    await userEvent.click(screen.getByRole("button", { name: /createTask/i }))

    // Save is disabled for blank title — use fireEvent to bypass the disabled attribute
    // and exercise the early-return guard inside handleCreate.
    const saveBtn = screen.getByRole("button", { name: /^save$/i })
    fireEvent.click(saveBtn)
    expect(createTaskMock).not.toHaveBeenCalled()
  })

  it("cancel button hides the form without calling createTask", async () => {
    render(<AgentTeamTasks teamId="t1" tasks={[makeTask("x")]} teammates={[]} />)
    const btns = screen.getAllByRole("button", { name: /createTask/i })
    await userEvent.click(btns[0])
    expect(screen.getByTestId("task-create-form")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    expect(screen.queryByTestId("task-create-form")).not.toBeInTheDocument()
    expect(createTaskMock).not.toHaveBeenCalled()
  })

  // ── delete ─────────────────────────────────────────────────────────────────

  it("calls deleteTask after confirming the alert dialog", async () => {
    render(
      <AgentTeamTasks
        teamId="t1"
        tasks={[makeTask("del1", { title: "To delete" })]}
        teammates={[]}
      />
    )
    const taskCard = screen.getByTestId("task-del1")
    // The card now has a comments toggle too — pick the trash/delete trigger.
    const trashBtn = within(taskCard)
      .getAllByRole("button")
      .find((b) => b.getAttribute("data-slot") === "alert-dialog-trigger") as HTMLElement
    await userEvent.click(trashBtn)

    // AlertDialog renders the action button; t("delete") → "delete"
    const confirmBtn = await screen.findByRole("button", { name: /^delete$/i })
    await userEvent.click(confirmBtn)

    expect(deleteTaskMock).toHaveBeenCalledWith("del1")
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it("does not call deleteTask when the dialog cancel is clicked", async () => {
    render(
      <AgentTeamTasks teamId="t1" tasks={[makeTask("del2", { title: "Keep me" })]} teammates={[]} />
    )
    const taskCard = screen.getByTestId("task-del2")
    const trashBtn = within(taskCard)
      .getAllByRole("button")
      .find((b) => b.getAttribute("data-slot") === "alert-dialog-trigger") as HTMLElement
    await userEvent.click(trashBtn)

    const cancelBtn = await screen.findByRole("button", { name: /^cancel$/i })
    await userEvent.click(cancelBtn)

    expect(deleteTaskMock).not.toHaveBeenCalled()
  })

  // ── animation branches: non-reduced-motion path ────────────────────────────

  it("renders task rows without animation reduction when prefersReducedMotion is false", () => {
    // Return false from the inner mock function so the non-reduced-motion
    // branches in motion.div initial/transition props (lines 193–207) are reached.
    mockUseReducedMotion.mockReturnValueOnce(false)

    render(
      <AgentTeamTasks
        teamId="t1"
        tasks={[makeTask("am1"), makeTask("am2"), makeTask("am3")]}
        teammates={[]}
      />
    )
    expect(screen.getByTestId("task-am1")).toBeInTheDocument()
    expect(screen.getByTestId("task-am2")).toBeInTheDocument()
    expect(screen.getByTestId("task-am3")).toBeInTheDocument()
  })

  it("toggles the comment thread open and closed", async () => {
    const user = userEvent.setup()
    render(<AgentTeamTasks teamId="t1" tasks={[makeTask("ct1")]} teammates={[]} />)
    expect(screen.queryByTestId("mock-comments-ct1")).toBeNull()
    await user.click(screen.getByTestId("task-ct1-comments-toggle"))
    expect(screen.getByTestId("mock-comments-ct1")).toBeInTheDocument()
    await user.click(screen.getByTestId("task-ct1-comments-toggle"))
    expect(screen.queryByTestId("mock-comments-ct1")).toBeNull()
  })
})
