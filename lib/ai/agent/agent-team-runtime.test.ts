/**
 * @jest-environment jsdom
 *
 * Tests for the F-path synthesizer (ADR-0022). The legacy in-place
 * orchestrator was rewritten to a thin synthesizer that delegates to
 * workflow runtime; tests below exercise the new contract:
 *  - storeReader / storeWriter shape
 *  - plan-approval gate via approval-bus
 *  - terminal status mapping ({completed, failed, cancelled})
 *  - double-start prevention via inflightControllers
 */
import "fake-indexeddb/auto"

// Mock plugin hooks so we don't need to boot the plugin store.
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: jest.fn(() => ({
    dispatchWorkflowStart: jest.fn(),
    dispatchWorkflowStepComplete: jest.fn(),
    dispatchWorkflowComplete: jest.fn(),
    dispatchWorkflowError: jest.fn(),
  })),
}))

jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: jest.fn(),
}))
import { executeAgent } from "@/lib/ai/agent/agent-executor"

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  runTeamLifecycle,
  parseProposedPlan,
  __resetInflightForTesting,
  type RunTeamLifecycleDeps,
} from "./agent-team-runtime"
import { approve, reject, __resetForTesting as resetApprovalBus } from "@/lib/runtime/approval-bus"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"

const lead: AgentTeammate = {
  id: "lead-1",
  teamId: "team-1",
  name: "Lead",
  description: "lead",
  role: "lead",
  status: "idle",
  config: {},
  completedTaskIds: [],
  tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  progress: 0,
  createdAt: new Date(),
} as AgentTeammate

const worker = (id: string): AgentTeammate =>
  ({
    id,
    teamId: "team-1",
    name: id,
    description: "",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
  }) as AgentTeammate

const baseTeam: AgentTeam = {
  id: "team-1",
  name: "Test",
  description: "",
  task: "do a thing",
  status: "idle",
  config: {
    maxTeammates: 5,
    maxConcurrentTeammates: 2,
    executionMode: "coordinated",
    displayMode: "expanded",
  },
  leadId: "lead-1",
  teammateIds: ["lead-1", "w1", "w2"],
  taskIds: [],
  messageIds: [],
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(),
} as AgentTeam

const task = (id: string, deps: string[] = []): AgentTeamTask =>
  ({
    id,
    teamId: "team-1",
    title: id,
    description: `desc ${id}`,
    status: "pending",
    priority: "normal",
    dependencies: deps,
    tags: [],
    createdAt: new Date(),
    order: 0,
  }) as AgentTeamTask

const buildDeps = (
  team: AgentTeam,
  tasks: AgentTeamTask[],
  members: AgentTeammate[]
): RunTeamLifecycleDeps & {
  _messages: Array<Record<string, unknown>>
  _taskStatuses: Record<string, string>
} => {
  const messages: Array<Record<string, unknown>> = []
  const taskStatuses: Record<string, string> = {}
  return {
    storeReader: {
      getTeam: (id: string) => (id === team.id ? team : undefined),
      getTeammates: () => members,
      getTeamTasks: () => tasks,
    },
    storeWriter: {
      addMessage: (m) => {
        messages.push(m as unknown as Record<string, unknown>)
      },
      setTaskStatus: (id: string, status: string) => {
        taskStatuses[id] = status
      },
      updateTeammate: () => {},
    },
    runLeadPlanning: jest.fn(async () => ({
      planText: '```json\n{"summary":"x","steps":[]}\n```',
    })),
    notifierDeps: {
      toast: () => {},
      osNotify: async () => {},
      log: async () => {},
    },
    _messages: messages,
    _taskStatuses: taskStatuses,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflowRuns.clear()
  await getDb().workflowRunEvents.clear()
  __resetInflightForTesting()
  resetApprovalBus()
  ;(executeAgent as jest.Mock).mockReset()
})

afterEach(() => {
  __resetInflightForTesting()
  resetApprovalBus()
})

describe("parseProposedPlan", () => {
  it("parses a fenced ```json block", () => {
    const r = parseProposedPlan('```json\n{"a":1}\n```')
    expect(r).toEqual({ ok: true, plan: { a: 1 } })
  })

  it("returns ok:false for empty input", () => {
    expect(parseProposedPlan("")).toMatchObject({ ok: false, reason: "empty plan text" })
  })

  it("returns ok:false for malformed JSON", () => {
    const r = parseProposedPlan("not json")
    expect(r.ok).toBe(false)
  })
})

describe("runTeamLifecycle (F-path synthesizer)", () => {
  it("fails fast when team not found", async () => {
    const deps = buildDeps(baseTeam, [], [lead, worker("w1")])
    const result = await runTeamLifecycle("missing", deps)
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/not found/)
  })

  it("fails fast when no workers", async () => {
    const deps = buildDeps(baseTeam, [task("t1")], [lead])
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/No teammates/)
  })

  it("fails fast when no tasks", async () => {
    const deps = buildDeps(baseTeam, [], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/No tasks/)
  })

  it("happy path: independent tasks complete via workflow", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "result",
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    })

    const deps = buildDeps(baseTeam, [task("t1"), task("t2")], [lead, worker("w1"), worker("w2")])
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    expect(deps._taskStatuses).toMatchObject({ t1: "completed", t2: "completed" })
  })

  it("dependency chain executes in order", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })

    const deps = buildDeps(baseTeam, [task("a"), task("b", ["a"])], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
  })

  it("returns cancelled when external signal aborts before start", async () => {
    const ac = new AbortController()
    ac.abort()
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", deps, ac.signal)
    expect(result.status).toBe("cancelled")
  })

  it("prevents double-start of the same team", async () => {
    ;(executeAgent as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                text: "ok",
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              }),
            50
          )
        )
    )
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])
    const first = runTeamLifecycle("team-1", deps)
    await expect(runTeamLifecycle("team-1", deps)).rejects.toThrow(/already running/)
    await first
  })
})

describe("runTeamLifecycle — plan-approval gate", () => {
  const teamWithApproval = (revisions = 3): AgentTeam => ({
    ...baseTeam,
    config: { ...baseTeam.config, requirePlanApproval: true, maxPlanRevisions: revisions },
  })

  it("approves on first revision → run completes", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    const runPromise = runTeamLifecycle("team-1", deps)
    await new Promise((r) => setTimeout(r, 30))
    approve({ scope: "agent-team", id: "team-1" })
    const result = await runPromise
    expect(result.status).toBe("completed")
  })

  it("rejects past max revisions → failed", async () => {
    const deps = buildDeps(teamWithApproval(2), [task("t1")], [lead, worker("w1")])
    const runPromise = runTeamLifecycle("team-1", deps)
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 30))
      reject({ scope: "agent-team", id: "team-1" }, "no good")
    }
    const result = await runPromise
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/rejected/)
  })

  it("fails fast when runLeadPlanning dep is missing", async () => {
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    delete (deps as { runLeadPlanning?: unknown }).runLeadPlanning
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/runLeadPlanning/)
  })
})
