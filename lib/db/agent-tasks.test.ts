import { createDbTestFixture } from "./test-fixture"
import {
  addAgentTaskComment,
  beginAgentTaskAttempt,
  createAgentTask,
  getAgentTask,
  linkAgentTaskAttemptExecution,
  listAgentTaskAttempts,
  listAgentTasks,
  moveAgentTask,
  reconcileAgentTaskAttempts,
  settleAgentTaskAttempt,
} from "./agent-tasks"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("single-Agent task persistence", () => {
  it("creates and lists durable board cards per Agent", async () => {
    await createAgentTask({
      id: "task-1",
      agentId: "agent-a",
      title: "Research",
      description: "Find primary sources",
      priority: "high",
      approvalPolicy: "manual",
      now: 10,
    })
    await createAgentTask({
      id: "task-2",
      agentId: "agent-b",
      title: "Other",
      description: "Other",
      now: 11,
    })

    expect((await listAgentTasks("agent-a")).map((task) => task.id)).toEqual(["task-1"])
  })

  it("derives dependency blocking and refuses duplicate concurrent attempts", async () => {
    await createAgentTask({
      id: "dep",
      agentId: "agent-a",
      title: "Dependency",
      description: "",
      approvalPolicy: "auto",
    })
    await createAgentTask({
      id: "task",
      agentId: "agent-a",
      title: "Task",
      description: "",
      dependencies: ["dep"],
    })

    await expect(beginAgentTaskAttempt("task", { id: "attempt-1", now: 20 })).rejects.toThrow(
      /dependencies/
    )
    expect((await getAgentTask("task"))?.status).toBe("blocked")

    const depAttempt = await beginAgentTaskAttempt("dep", { id: "dep-attempt", now: 24 })
    await settleAgentTaskAttempt(depAttempt.id, { status: "completed", result: "done", now: 25 })

    const first = await beginAgentTaskAttempt("task", { id: "attempt-1", now: 26 })
    expect(first.attemptNo).toBe(1)
    await expect(beginAgentTaskAttempt("task", { id: "attempt-2", now: 27 })).rejects.toThrow(
      /already running/
    )
  })

  it("appends retry attempts and routes successful manual work through review", async () => {
    await createAgentTask({
      id: "task",
      agentId: "agent-a",
      title: "Task",
      description: "",
      approvalPolicy: "manual",
    })
    const first = await beginAgentTaskAttempt("task", { id: "attempt-1", now: 10 })
    await settleAgentTaskAttempt(first.id, {
      status: "failed",
      errorCode: "provider_error",
      errorMessage: "offline",
      now: 11,
    })
    await moveAgentTask("task", "pending", 12)
    const second = await beginAgentTaskAttempt("task", { id: "attempt-2", now: 13 })
    await settleAgentTaskAttempt(second.id, { status: "completed", result: "ok", now: 14 })

    expect((await listAgentTaskAttempts("task")).map((attempt) => attempt.status)).toEqual([
      "failed",
      "review",
    ])
    expect((await getAgentTask("task"))?.status).toBe("review")
  })

  it("links Scheduler execution ids and reconciles orphaned running attempts", async () => {
    await createAgentTask({ id: "task", agentId: "agent-a", title: "Task", description: "" })
    const attempt = await beginAgentTaskAttempt("task", { id: "attempt-1", now: 10 })
    await linkAgentTaskAttemptExecution(attempt.id, "execution-1", 11)

    await reconcileAgentTaskAttempts(async (executionId) =>
      executionId === "execution-1" ? null : null
    , 20)

    expect((await listAgentTaskAttempts("task"))[0]).toEqual(
      expect.objectContaining({ status: "interrupted", errorCode: "execution_missing" })
    )
    expect((await getAgentTask("task"))?.status).toBe("failed")
  })

  it("persists bounded comments on the card", async () => {
    await createAgentTask({ id: "task", agentId: "agent-a", title: "Task", description: "" })
    await addAgentTaskComment("task", { id: "comment-1", author: "user", text: "Review this" }, 10)
    expect((await getAgentTask("task"))?.comments).toEqual([
      { id: "comment-1", author: "user", text: "Review this", createdAt: 10 },
    ])
  })
})
