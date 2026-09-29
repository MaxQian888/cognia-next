/**
 * @jest-environment jsdom
 */

/**
 * The write half against the real scheduler table (it is a table of the
 * account database the fixture opens) and a stand-in scheduler whose calls
 * the tests can see, so what the scheduler was ASKED to do is asserted, not
 * just what ended up in the row.
 */

import type { ScheduledTask } from "@/types/scheduler"

const mockScheduler = {
  createTask: jest.fn(),
  pauseTask: jest.fn(),
  resumeTask: jest.fn(),
  deleteTask: jest.fn(),
  updateTask: jest.fn(),
}
jest.mock("@/lib/scheduler/task-scheduler", () => ({ getTaskScheduler: () => mockScheduler }))

const mockAuthorize = jest.fn()
jest.mock("@/lib/scheduler/write-authority", () => ({
  authorizeTaskWrite: (...args: unknown[]) => mockAuthorize(...args),
  verdictNeedsConfirmation: (verdict: { requiresConfirmation?: boolean }) =>
    verdict.requiresConfirmation === true,
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import {
  IssueWakeupWriteError,
  childrenDoneWakeupId,
  consumeIssueWakeup,
  createIssueWakeup,
  deleteWakeupsForIssues,
  ensureChildrenDoneWakeup,
  holdIssueWakeupInputs,
  listIssueWakeups,
  listWorkspaceIssueWakeups,
  pauseIssueWakeupFor,
  pauseWakeupsForIssue,
  reconcileChildrenDoneWakeups,
  setIssueWakeupDeferred,
  setIssueWakeupEnabled,
  withWakeupLock,
} from "./service"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

let containerId: string

beforeEach(async () => {
  jest.clearAllMocks()
  mockAuthorize.mockResolvedValue({ allowed: true })
  // The stand-in writes what the real scheduler would, so reads stay real.
  mockScheduler.createTask.mockImplementation(async (input) => {
    const now = new Date()
    const task: ScheduledTask = {
      id: `task_${Math.random().toString(36).slice(2, 8)}`,
      name: input.name,
      type: input.type,
      trigger: input.trigger,
      payload: input.payload,
      config: {
        timeout: 1,
        maxRetries: 0,
        retryDelay: 0,
        runMissedOnStartup: false,
        ...input.config,
      },
      notification: { onStart: false, onComplete: false, onError: true, ...input.notification },
      status: "active",
      projectId: input.projectId,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    await schedulerDb.createTask(task)
    return task
  })
  mockScheduler.pauseTask.mockImplementation(async (id: string) => {
    const task = await schedulerDb.getTask(id)
    if (task) await schedulerDb.updateTask({ ...task, status: "paused" })
    return true
  })
  mockScheduler.resumeTask.mockResolvedValue(true)
  mockScheduler.deleteTask.mockImplementation(async (id: string) => schedulerDb.deleteTask(id))
  mockScheduler.updateTask.mockResolvedValue(null)
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

const makeIssue = (over: Partial<Parameters<typeof createIssue>[0]> = {}) =>
  createIssue({
    projectId: "w1",
    issueProjectId: containerId,
    title: "x",
    createdBy: { kind: "human" },
    status: "todo",
    ...over,
  })

async function addRule(issueId: string, over: Record<string, unknown> = {}) {
  return createIssueWakeup({
    issueId,
    instruction: "Answer it",
    trigger: { on: "event", kinds: ["commented"] },
    source: "user",
    ...over,
  })
}

describe("createIssueWakeup", () => {
  it("creates an issue-wakeup task bound to the issue's workspace", async () => {
    const issue = await makeIssue()
    const task = await addRule(issue.id)
    const input = mockScheduler.createTask.mock.calls[0][0]
    expect(input).toMatchObject({
      type: "issue-wakeup",
      name: `${issue.identifier} wakeup`,
      projectId: "w1",
      workspaceResolved: true,
      trigger: { type: "event", eventType: "issue:activity", eventSource: `issue:${issue.id}` },
      notification: { onStart: false, onComplete: false, onError: true },
    })
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: "issue-wakeup", source: "user", operation: "create" })
    )
    expect(await listIssueWakeups(issue.id)).toEqual([expect.objectContaining({ id: task.id })])
    expect(await listWorkspaceIssueWakeups("w1")).toHaveLength(1)
  })

  it("refuses a finished issue, a missing issue and a watched issue elsewhere", async () => {
    const done = await makeIssue({ status: "done" })
    await expect(addRule(done.id)).rejects.toMatchObject({ reason: "issue-finished" })
    await expect(addRule("nope")).rejects.toMatchObject({ reason: "issue-missing" })

    const other = await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    const foreign = await createIssue({
      projectId: "w2",
      issueProjectId: other.id,
      title: "y",
      createdBy: { kind: "human" },
    })
    const own = await makeIssue()
    await expect(
      addRule(own.id, { trigger: { on: "issue-finished", targetIssueId: foreign.id } })
    ).rejects.toMatchObject({ reason: "target-other-workspace" })
    expect(mockScheduler.createTask).not.toHaveBeenCalled()
  })

  it("refuses a pr-merged rule nobody could observe, and takes one on an import-bound project", async () => {
    const issue = await makeIssue()
    await expect(addRule(issue.id, { trigger: { on: "pr-merged" } })).rejects.toMatchObject({
      reason: "pr-unobservable",
    })
    const { addIssueProjectResource } = await import("@/lib/db/issue-projects")
    await addIssueProjectResource(containerId, {
      kind: "github-repo",
      repoFullName: "acme/app",
      addedAt: 1,
      sync: { mode: "import" },
    })
    await expect(addRule(issue.id, { trigger: { on: "pr-merged" } })).resolves.toMatchObject({
      payload: { condition: { kind: "pr-merged" } },
    })
  })

  it("surfaces a policy refusal, and a verdict that still wants a person", async () => {
    const issue = await makeIssue()
    mockAuthorize.mockResolvedValueOnce({ allowed: false, message: "Agents may not." })
    await expect(addRule(issue.id, { source: "agent" })).rejects.toThrow("Agents may not.")
    mockAuthorize.mockResolvedValueOnce({
      allowed: true,
      requiresConfirmation: true,
      message: "Confirm it.",
    })
    await expect(addRule(issue.id, { source: "agent" })).rejects.toBeInstanceOf(
      IssueWakeupWriteError
    )
  })
})

describe("pausing and resuming", () => {
  it("records why a rule paused itself", async () => {
    const issue = await makeIssue()
    const task = await addRule(issue.id)
    await pauseIssueWakeupFor(task.id, "loop")
    expect(await schedulerDb.getTask(task.id)).toMatchObject({
      status: "paused",
      lastTerminalReason: "wakeup-paused-loop",
    })
  })

  it("pauses every active rule an issue owns when it finishes", async () => {
    const issue = await makeIssue()
    const a = await addRule(issue.id)
    const b = await addRule(issue.id)
    await pauseIssueWakeupFor(b.id, "rate")
    expect(await pauseWakeupsForIssue(issue.id)).toEqual([a.id])
  })

  it("refuses to resume a rule while its issue is finished", async () => {
    const issue = await makeIssue()
    const task = await addRule(issue.id)
    await setIssueWakeupEnabled(task.id, false, { source: "user" })
    expect(mockScheduler.pauseTask).toHaveBeenCalledWith(task.id)
    const { db } = await import("@/lib/db/schema").then((m) => ({ db: m.getDb() }))
    await db.issues.update(issue.id, { status: "done", statusCategory: "completed" })
    await expect(setIssueWakeupEnabled(task.id, true, { source: "user" })).rejects.toMatchObject({
      reason: "issue-finished",
    })
    expect(mockScheduler.resumeTask).not.toHaveBeenCalled()
  })

  it("consumes a one-shot rule through the scheduler", async () => {
    await consumeIssueWakeup("t1")
    expect(mockScheduler.updateTask).toHaveBeenCalledWith("t1", { status: "expired" })
  })
})

describe("held inputs", () => {
  it("appends and clears without touching the trigger", async () => {
    const issue = await makeIssue()
    const task = await addRule(issue.id)
    const evidence = {
      kind: "commented" as const,
      subjectId: issue.id,
      ts: 1,
      summary: "s",
      chain: [],
    }
    await Promise.all([
      holdIssueWakeupInputs(task.id, (held) => [...held, evidence]),
      holdIssueWakeupInputs(task.id, (held) => [...held, { ...evidence, ts: 2 }]),
    ])
    const held = (await schedulerDb.getTask(task.id))?.payload as { deferred?: unknown[] }
    expect(held.deferred).toHaveLength(2)
    await setIssueWakeupDeferred(task.id, [])
    expect((await schedulerDb.getTask(task.id))?.payload).not.toHaveProperty("deferred")
    expect(mockScheduler.updateTask).not.toHaveBeenCalled()
  })

  it("runs locked work one at a time per key", async () => {
    const order: string[] = []
    await Promise.all([
      withWakeupLock("k", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push("first")
      }),
      withWakeupLock("k", async () => {
        order.push("second")
      }),
    ])
    expect(order).toEqual(["first", "second"])
  })
})

describe("cascade", () => {
  it("removes the rules a deleted issue owned and the rules watching it", async () => {
    const owner = await makeIssue()
    const watched = await makeIssue()
    const survivor = await makeIssue()
    const owned = await addRule(owner.id)
    const watching = await addRule(survivor.id, {
      trigger: { on: "issue-finished", targetIssueId: watched.id },
    })
    const kept = await addRule(survivor.id)
    const removed = await deleteWakeupsForIssues([owner.id, watched.id])
    expect(removed.sort()).toEqual([owned.id, watching.id].sort())
    expect(await listIssueWakeups(survivor.id)).toEqual([expect.objectContaining({ id: kept.id })])
  })
})

describe("the parent's children-done rule", () => {
  it("is created once, with a deterministic id, as a platform rule", async () => {
    const parent = await makeIssue()
    expect(await ensureChildrenDoneWakeup(parent.id)).toBe("created")
    expect(await ensureChildrenDoneWakeup(parent.id)).toBe("exists")
    const task = await schedulerDb.getTask(childrenDoneWakeupId(parent.id))
    expect(task).toMatchObject({
      type: "issue-wakeup",
      status: "active",
      projectId: "w1",
      trigger: { type: "event", eventType: "issue:activity", eventSource: `issue:${parent.id}` },
      payload: {
        issueId: parent.id,
        system: "children-done",
        condition: { kind: "children-done" },
        author: { kind: "agent", label: "issue-wakeup" },
      },
    })
    expect((task?.payload as { once?: boolean }).once).toBeUndefined()
  })

  it("is skipped for a finished parent", async () => {
    const parent = await makeIssue({ status: "canceled" })
    expect(await ensureChildrenDoneWakeup(parent.id)).toBe("skipped")
  })

  it("is reconciled at boot for every parent that already has children", async () => {
    const parent = await makeIssue()
    await makeIssue({ parentId: parent.id })
    await makeIssue({ parentId: parent.id })
    await makeIssue()
    expect(await reconcileChildrenDoneWakeups()).toBe(1)
    expect(await reconcileChildrenDoneWakeups()).toBe(0)
  })
})
