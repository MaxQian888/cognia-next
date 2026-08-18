/**
 * @jest-environment jsdom
 */

import type { AgentTask, AgentTaskAttempt } from "@/types/agent/agent-task"
import type { Issue, IssueProject, IssueRun } from "@/types/issues"
import {
  AGENT_TASK_BOARD_HREF,
  AGENT_TASK_RUN_ADAPTER_ID,
  agentTaskArtifacts,
  buildAgentTaskDescription,
  createAgentTaskRunAdapter,
  issuePriorityToAgentTaskPriority,
  sessionHref,
  type AgentTaskRunAdapterDeps,
} from "./agent-task-adapter"
import type { IssueRunTarget } from "./types"

const HUMAN = { kind: "human" } as const

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "iss-1",
    identifier: "MERC-1",
    number: 1,
    projectId: "w1",
    issueProjectId: "ip-1",
    title: "Fix the thing",
    description: "It is broken",
    status: "todo",
    statusCategory: "unstarted",
    priority: "high",
    assignee: { kind: "agent", id: "char-1", label: "Ada" },
    assigneeKind: "agent",
    assigneeId: "char-1",
    createdBy: HUMAN,
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function project(over: Partial<IssueProject> = {}): IssueProject {
  return {
    id: "ip-1",
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    description: "The Mercury project",
    status: "in_progress",
    priority: "none",
    resources: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function target(over: Partial<IssueRunTarget> = {}): IssueRunTarget {
  return { issue: issue(), project: project(), ...over }
}

function task(over: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "agent-task:abc",
    agentId: "char-1",
    title: "MERC-1: Fix the thing",
    description: "…",
    status: "pending",
    priority: "high",
    dependencies: [],
    tags: [],
    order: 0,
    approvalPolicy: "on-risk",
    latestAttemptNo: 0,
    comments: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...over,
  }
}

function attempt(over: Partial<AgentTaskAttempt> = {}): AgentTaskAttempt {
  return {
    id: "att-1",
    taskId: "agent-task:abc",
    agentId: "char-1",
    attemptNo: 1,
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function run(over: Partial<IssueRun> = {}): IssueRun {
  return {
    id: "run-1",
    issueId: "iss-1",
    projectId: "w1",
    adapterId: AGENT_TASK_RUN_ADAPTER_ID,
    kind: "agent-task",
    targetId: "agent-task:abc",
    status: "running",
    by: HUMAN,
    startedAt: 1,
    updatedAt: 1,
    artifacts: [],
    ...over,
  }
}

function makeDeps(over: Partial<AgentTaskRunAdapterDeps> = {}) {
  const created: Parameters<AgentTaskRunAdapterDeps["createTask"]>[0][] = []
  const runs: Parameters<AgentTaskRunAdapterDeps["createRun"]>[0][] = []
  const started: string[] = []
  const cancelled: string[] = []
  const marked: string[] = []
  const deps: AgentTaskRunAdapterDeps = {
    resolveCharacter: async (id) => (id === "char-1" ? { id, name: "Ada" } : undefined),
    createTask: async (input) => {
      created.push(input)
      return task({ id: "agent-task:new", agentId: input.agentId, title: input.title })
    },
    runTaskNow: async (id) => {
      started.push(id)
    },
    cancelTask: async (id) => {
      cancelled.push(id)
    },
    getTask: async () => undefined,
    listAttempts: async () => [],
    createRun: async (input) => {
      runs.push(input)
      return run({ id: "run-new", targetId: input.targetId, status: input.status ?? "running" })
    },
    markRunning: async (id) => {
      marked.push(id)
    },
    now: () => 42,
    ...over,
  }
  return { deps, created, runs, started, cancelled, marked }
}

describe("helpers", () => {
  it("builds the task prompt from identifier, project context and description", () => {
    expect(buildAgentTaskDescription(target())).toBe(
      "Issue MERC-1: Fix the thing\n\nProject context: The Mercury project\n\nIt is broken"
    )
    expect(
      buildAgentTaskDescription(
        target({ issue: issue({ description: undefined }), project: undefined })
      )
    ).toBe("Issue MERC-1: Fix the thing")
  })

  it("maps priorities and builds artifacts from attempts with sessions", () => {
    expect(issuePriorityToAgentTaskPriority("urgent")).toBe("critical")
    expect(issuePriorityToAgentTaskPriority("high")).toBe("high")
    expect(issuePriorityToAgentTaskPriority("medium")).toBe("normal")
    expect(issuePriorityToAgentTaskPriority("low")).toBe("low")
    expect(issuePriorityToAgentTaskPriority("none")).toBe("normal")
    expect(sessionHref("s 1")).toBe("/?session=s%201")
    expect(agentTaskArtifacts([attempt(), attempt({ attemptNo: 2, sessionId: "s2" })])).toEqual([
      { label: "Session (attempt 2)", href: "/?session=s2" },
    ])
    expect(AGENT_TASK_BOARD_HREF).toBe("/settings?section=characters")
  })
})

describe("canRun", () => {
  it("accepts an agent assignee that resolves to a Character", async () => {
    const adapter = createAgentTaskRunAdapter(makeDeps().deps)
    expect(await adapter.canRun(target())).toEqual({ ok: true })
  })

  it("refuses missing / wrong-kind / id-less / unresolvable assignees", async () => {
    const adapter = createAgentTaskRunAdapter(makeDeps().deps)
    expect(await adapter.canRun(target({ issue: issue({ assignee: undefined }) }))).toEqual({
      ok: false,
      reason: "assignee-kind-mismatch",
    })
    expect(
      await adapter.canRun(target({ issue: issue({ assignee: { kind: "team", id: "t" } }) }))
    ).toMatchObject({ ok: false, reason: "assignee-kind-mismatch" })
    expect(
      await adapter.canRun(target({ issue: issue({ assignee: { kind: "agent" } }) }))
    ).toMatchObject({ ok: false, reason: "assignee-kind-mismatch" })
    expect(
      await adapter.canRun(target({ issue: issue({ assignee: { kind: "agent", id: "ghost" } }) }))
    ).toEqual({ ok: false, reason: "assignee-not-found", detail: "ghost" })
  })
})

describe("start", () => {
  it("creates the AgentTask, records a queued run, dispatches, then marks running", async () => {
    const { deps, created, runs, started, marked } = makeDeps()
    const adapter = createAgentTaskRunAdapter(deps)
    const result = await adapter.start(target(), { by: HUMAN, origin: "interactive" })
    expect(created[0]).toMatchObject({
      agentId: "char-1",
      projectId: "w1",
      title: "MERC-1: Fix the thing",
      priority: "high",
      tags: ["issue", "issue:iss-1", "MERC-1"],
      now: 42,
    })
    expect(runs[0]).toMatchObject({
      issueId: "iss-1",
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      kind: "agent-task",
      targetId: "agent-task:new",
      status: "queued",
      by: HUMAN,
    })
    expect(started).toEqual(["agent-task:new"])
    expect(marked).toEqual(["run-new"])
    expect(result.status).toBe("running")
  })

  it("throws when the target is not runnable and when the scheduler refuses", async () => {
    const { deps } = makeDeps({
      runTaskNow: async () => {
        throw new Error("scheduler down")
      },
    })
    const adapter = createAgentTaskRunAdapter(deps)
    await expect(
      adapter.start(target({ issue: issue({ assignee: undefined }) }), { by: HUMAN, origin: "im" })
    ).rejects.toThrow(/refused: assignee-kind-mismatch/)
    await expect(adapter.start(target(), { by: HUMAN, origin: "im" })).rejects.toThrow(
      "scheduler down"
    )
  })
})

describe("poll", () => {
  it("returns null while the task is not terminal", async () => {
    for (const status of ["pending", "blocked", "in_progress", "paused"] as const) {
      const { deps } = makeDeps({ getTask: async () => task({ status }) })
      expect(await createAgentTaskRunAdapter(deps).poll(run())).toBeNull()
    }
  })

  it("settles from the task's terminal status with attempts as evidence", async () => {
    const attempts = [attempt({ sessionId: "s1", result: "did the thing" })]
    const completed = createAgentTaskRunAdapter(
      makeDeps({
        getTask: async () => task({ status: "completed" }),
        listAttempts: async () => attempts,
      }).deps
    )
    expect(await completed.poll(run())).toEqual({
      status: "succeeded",
      summary: "did the thing",
      artifacts: [{ label: "Session (attempt 1)", href: "/?session=s1" }],
    })

    const review = createAgentTaskRunAdapter(
      makeDeps({ getTask: async () => task({ status: "review" }), listAttempts: async () => [] })
        .deps
    )
    expect(await review.poll(run())).toEqual({ status: "succeeded", artifacts: [] })

    const failed = createAgentTaskRunAdapter(
      makeDeps({
        getTask: async () => task({ status: "failed" }),
        listAttempts: async () => [attempt({ status: "failed", errorCode: "E1" })],
      }).deps
    )
    expect(await failed.poll(run())).toEqual({ status: "failed", error: "E1", artifacts: [] })

    const failedNoAttempt = createAgentTaskRunAdapter(
      makeDeps({ getTask: async () => task({ status: "failed" }) }).deps
    )
    expect(await failedNoAttempt.poll(run())).toMatchObject({ error: "agent task failed" })

    const cancelled = createAgentTaskRunAdapter(
      makeDeps({ getTask: async () => task({ status: "cancelled" }) }).deps
    )
    expect(await cancelled.poll(run())).toEqual({ status: "cancelled" })

    const gone = createAgentTaskRunAdapter(makeDeps().deps)
    expect(await gone.poll(run())).toEqual({
      status: "failed",
      error: "agent task no longer exists",
    })
  })
})

describe("cancel", () => {
  it("cancels the AgentTask", async () => {
    const { deps, cancelled } = makeDeps()
    await createAgentTaskRunAdapter(deps).cancel!(run())
    expect(cancelled).toEqual(["agent-task:abc"])
  })
})
