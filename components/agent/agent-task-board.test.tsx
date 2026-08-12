import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { AgentTask } from "@/types/agent/agent-task"

const useLiveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => useLiveQueryMock(...args),
}))

let dragEnd: ((event: unknown) => void) | undefined
jest.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: React.ReactNode
    onDragEnd: (event: unknown) => void
  }) => {
    dragEnd = onDragEnd
    return <div>{children}</div>
  },
  PointerSensor: function PointerSensor() {},
  closestCorners: jest.fn(),
  useSensor: jest.fn(() => ({})),
  useSensors: jest.fn(() => []),
  useDraggable: jest.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: jest.fn(),
    transform: null,
    isDragging: false,
  })),
  useDroppable: jest.fn(() => ({ setNodeRef: jest.fn(), isOver: false })),
}))

const createAgentTaskMock = jest.fn()
const moveAgentTaskMock = jest.fn()
const addCommentMock = jest.fn()
jest.mock("@/lib/db/agent-tasks", () => ({
  listAgentTasks: jest.fn(),
  listAgentTaskAttempts: jest.fn(),
  createAgentTask: (...args: unknown[]) => createAgentTaskMock(...args),
  moveAgentTask: (...args: unknown[]) => moveAgentTaskMock(...args),
  addAgentTaskComment: (...args: unknown[]) => addCommentMock(...args),
}))
const runNowMock = jest.fn()
const ensureScheduleMock = jest.fn()
jest.mock("@/lib/agent-tasks/runtime", () => ({
  runAgentTaskNow: (...args: unknown[]) => runNowMock(...args),
  ensureAgentTaskSchedule: (...args: unknown[]) => ensureScheduleMock(...args),
  pauseAgentTask: jest.fn(),
  resumeAgentTask: jest.fn(),
  cancelAgentTask: jest.fn(),
}))
const skillSuggestionCardMock = jest.fn((..._args: unknown[]) => (
  <div data-testid="run-skill-suggestion" />
))
jest.mock("@/components/chat/skill-suggestion-card", () => ({
  SkillSuggestionCard: (props: unknown) => skillSuggestionCardMock(props),
}))

import { AgentTaskBoard, AgentTaskBoardDialog } from "./agent-task-board"

const baseTask: AgentTask = {
  id: "task-1",
  agentId: "agent-1",
  title: "Research",
  description: "Find sources",
  status: "pending",
  priority: "high",
  dependencies: [],
  tags: [],
  order: 0,
  approvalPolicy: "manual",
  latestAttemptNo: 0,
  comments: [],
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
}

beforeEach(() => {
  dragEnd = undefined
  useLiveQueryMock.mockReset().mockReturnValue([])
  createAgentTaskMock.mockReset().mockResolvedValue(baseTask)
  moveAgentTaskMock.mockReset().mockResolvedValue(undefined)
  addCommentMock.mockReset().mockResolvedValue(undefined)
  runNowMock.mockReset().mockResolvedValue(undefined)
  ensureScheduleMock.mockReset().mockResolvedValue("scheduled-1")
  skillSuggestionCardMock.mockClear()
})

it("creates an immediate durable task from the board form", async () => {
  render(<AgentTaskBoard agentId="agent-1" />)
  fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Research" } })
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Find sources" } })
  fireEvent.click(screen.getByRole("button", { name: "Add task" }))

  await waitFor(() =>
    expect(createAgentTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        title: "Research",
        description: "Find sources",
      })
    )
  )
  expect(ensureScheduleMock).not.toHaveBeenCalled()
})

it("starts a pending card through the shared Scheduler runtime", async () => {
  useLiveQueryMock.mockReturnValueOnce([baseTask]).mockReturnValueOnce([])
  render(<AgentTaskBoard agentId="agent-1" />)
  fireEvent.click(screen.getByRole("button", { name: "Start" }))
  await waitFor(() => expect(runNowMock).toHaveBeenCalledWith("task-1"))
})

it("uses guarded drag transitions for review verdicts", async () => {
  useLiveQueryMock.mockReturnValueOnce([{ ...baseTask, status: "review" }]).mockReturnValueOnce([])
  render(<AgentTaskBoard agentId="agent-1" />)
  dragEnd?.({ active: { id: "task-1" }, over: { id: "status:completed" } })
  await waitFor(() => expect(moveAgentTaskMock).toHaveBeenCalledWith("task-1", "completed"))
})

it("offers successful run attempts to the Skill review flow", async () => {
  const completedAttempts = [
    {
      id: "attempt-1",
      taskId: "task-1",
      agentId: "agent-1",
      attemptNo: 1,
      status: "completed",
      result: "done",
    },
  ]
  useLiveQueryMock.mockImplementation((_query: unknown, deps: unknown[]) =>
    deps[0] === "agent-1" ? [{ ...baseTask, status: "completed" }] : completedAttempts
  )
  render(<AgentTaskBoard agentId="agent-1" />)
  fireEvent.click(screen.getByRole("button", { name: /attempts/ }))
  await waitFor(() => expect(screen.getByTestId("run-skill-suggestion")).toBeInTheDocument())
  expect(skillSuggestionCardMock).toHaveBeenCalledWith(
    expect.objectContaining({
      source: { kind: "run", runId: "attempt-1" },
      outcome: expect.objectContaining({ completed: true }),
    })
  )
})

it("opens the selected Agent's board from the Agent row action", () => {
  render(<AgentTaskBoardDialog agentId="agent-1" agentName="Ada" />)
  fireEvent.click(screen.getByRole("button", { name: "Open Ada's task board" }))
  expect(screen.getByRole("dialog")).toHaveTextContent("Ada task board")
})
