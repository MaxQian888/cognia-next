import {
  handleAgentTaskCancel,
  handleAgentTaskComment,
  handleAgentTaskMove,
  handleAgentTaskPause,
  handleAgentTaskResume,
  handleAgentTaskStart,
} from "./agent-task-write-handlers"

const mockGetAgentTask = jest.fn()
const mockMoveAgentTask = jest.fn()
const mockAddAgentTaskComment = jest.fn()
const mockRunAgentTaskNow = jest.fn()
const mockPauseAgentTask = jest.fn()
const mockResumeAgentTask = jest.fn()
const mockCancelAgentTask = jest.fn()

jest.mock("@/lib/db/agent-tasks", () => ({
  getAgentTask: (...args: unknown[]) => mockGetAgentTask(...args),
  moveAgentTask: (...args: unknown[]) => mockMoveAgentTask(...args),
  addAgentTaskComment: (...args: unknown[]) => mockAddAgentTaskComment(...args),
}))

jest.mock("@/lib/agent-tasks/runtime", () => ({
  runAgentTaskNow: (...args: unknown[]) => mockRunAgentTaskNow(...args),
  pauseAgentTask: (...args: unknown[]) => mockPauseAgentTask(...args),
  resumeAgentTask: (...args: unknown[]) => mockResumeAgentTask(...args),
  cancelAgentTask: (...args: unknown[]) => mockCancelAgentTask(...args),
}))

const task = { id: "task-1", agentId: "agent-1", status: "pending" }

beforeEach(() => {
  jest.clearAllMocks()
  mockGetAgentTask.mockResolvedValue(task)
  mockMoveAgentTask.mockResolvedValue({ ...task, status: "completed" })
  mockAddAgentTaskComment.mockImplementation(async (_taskId, comment) => comment)
  mockRunAgentTaskNow.mockResolvedValue({ id: "execution-1" })
})

describe("Agent task Companion write handlers", () => {
  it("validates the Agent scope before starting a task", async () => {
    await expect(
      handleAgentTaskStart({ agentId: "agent-2", taskId: "task-1" })
    ).resolves.toEqual({ ok: false, reason: "task-not-found" })
    expect(mockRunAgentTaskNow).not.toHaveBeenCalled()
  })

  it("starts a task through the shared Scheduler runtime", async () => {
    await expect(
      handleAgentTaskStart({ agentId: "agent-1", taskId: "task-1" })
    ).resolves.toEqual({ ok: true, executionId: "execution-1" })
    expect(mockRunAgentTaskNow).toHaveBeenCalledWith("task-1")
  })

  it.each([
    ["pause", handleAgentTaskPause, mockPauseAgentTask],
    ["resume", handleAgentTaskResume, mockResumeAgentTask],
    ["cancel", handleAgentTaskCancel, mockCancelAgentTask],
  ] as const)("routes %s through the shared runtime", async (_name, handler, runtime) => {
    await expect(handler({ agentId: "agent-1", taskId: "task-1" })).resolves.toEqual({
      ok: true,
    })
    expect(runtime).toHaveBeenCalledWith("task-1")
  })

  it("adds bounded user comments through the task repository", async () => {
    const result = await handleAgentTaskComment({
      agentId: "agent-1",
      taskId: "task-1",
      text: "  ship it  ",
    })

    expect(result).toMatchObject({ ok: true })
    expect(result.commentId).toMatch(/^agent-task-comment:/)
    expect(mockAddAgentTaskComment).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ author: "user", text: "ship it" })
    )
  })

  it("supports guarded review decisions and retry moves", async () => {
    await expect(
      handleAgentTaskMove({ agentId: "agent-1", taskId: "task-1", to: "completed" })
    ).resolves.toEqual({ ok: true })
    expect(mockMoveAgentTask).toHaveBeenCalledWith("task-1", "completed")
  })

  it("rejects malformed payloads and runtime-owned status moves", async () => {
    await expect(handleAgentTaskStart({ taskId: "task-1" })).resolves.toEqual({
      ok: false,
      reason: "invalid-payload",
    })
    await expect(
      handleAgentTaskMove({ agentId: "agent-1", taskId: "task-1", to: "in_progress" })
    ).resolves.toEqual({ ok: false, reason: "invalid-status" })
  })

  it("returns stable denial codes instead of leaking runtime errors", async () => {
    mockPauseAgentTask.mockRejectedValueOnce(new Error("secret filesystem detail"))
    await expect(
      handleAgentTaskPause({ agentId: "agent-1", taskId: "task-1" })
    ).resolves.toEqual({ ok: false, reason: "transition-denied" })
  })
})
