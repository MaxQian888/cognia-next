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
    dispatchWorkflowNodeStart: jest.fn(),
    dispatchWorkflowNodeComplete: jest.fn(),
    dispatchWorkflowNodeError: jest.fn(),
  })),
  getPluginLifecycleHooks: jest.fn(() => ({
    dispatchOnTeamStart: jest.fn(),
    dispatchOnTeamPlanReady: jest.fn(),
    dispatchOnTeammateClaim: jest.fn(),
    dispatchOnTeammateRelease: jest.fn(),
    dispatchOnTeamBudgetWarn: jest.fn(),
    dispatchOnTeamComplete: jest.fn(),
    dispatchOnAgentStart: jest.fn(),
    dispatchOnAgentComplete: jest.fn(),
    dispatchOnAgentError: jest.fn(),
    dispatchOnConsensusOpened: jest.fn(),
    dispatchOnConsensusVoted: jest.fn(),
    dispatchOnConsensusResolved: jest.fn(),
    dispatchOnSharedMemoryWrite: jest.fn(),
    dispatchOnSharedMemoryDelete: jest.fn(),
    dispatchOnTeamDelegationStart: jest.fn(),
    dispatchOnTeamDelegationComplete: jest.fn(),
  })),
}))

jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: jest.fn(),
}))
import { executeAgent } from "@/lib/ai/agent/agent-executor"

// Stub the twin runtime so the per-run twin block is observable without the
// vector store / Dexie. Returning no twinDeps keeps every non-twin test's
// behavior identical to before this feature existed.
jest.mock("./team/twin-context", () => ({
  resolveTeamTwinRuntime: jest.fn(async () => ({ availableTwins: [] })),
  applyTeammateTwinContext: jest.fn(async (i: { baseSystemPrompt: string }) => ({
    systemPrompt: i.baseSystemPrompt,
    applied: false,
  })),
  searchTwinKnowledge: jest.fn(async () => ({ hits: [], degraded: false })),
  gatherTeamTwins: jest.fn(async () => []),
}))
import { resolveTeamTwinRuntime } from "./team/twin-context"
const resolveTeamTwinRuntimeMock = resolveTeamTwinRuntime as jest.Mock

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

  it("threads an IM triggeredFrom onto the team run row for progress fan-out", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = {
      ...buildDeps(baseTeam, [task("t1")], [lead, worker("w1")]),
      triggeredFrom: {
        source: "im" as const,
        adapterId: "lark:a1",
        conversationKey: "lark:a1:oc_team",
        sessionId: "sess_1",
      },
    }
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    const row = await getDb().workflowRuns.get(result.runId)
    expect(row?.triggeredBy).toEqual({
      source: "im",
      adapterId: "lark:a1",
      conversationKey: "lark:a1:oc_team",
      sessionId: "sess_1",
    })
    // The origin is also mirrored onto the trigger binding for binding-aware nodes.
    expect(row?.triggerBinding).toMatchObject({
      adapterId: "lark:a1",
      conversationKey: "lark:a1:oc_team",
    })
  })

  it("omits triggeredBy for non-IM (UI/API) runs", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", deps)
    const row = await getDb().workflowRuns.get(result.runId)
    expect(row?.triggeredBy).toBeUndefined()
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

  it("runs the adaptive wave path when adaptiveReplan is enabled", async () => {
    // The single mock serves both task dispatches AND the between-wave replan
    // checkpoint: a fenced continue-JSON is non-empty (valid task output) and
    // parses to a valid ReplanDecision (continue → plan unchanged).
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: '```json\n{"action":"continue","reasoning":"steady"}\n```',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const adaptiveTeam = {
      ...baseTeam,
      config: { ...baseTeam.config, adaptiveReplan: { enabled: true } },
    } as AgentTeam
    const deps = buildDeps(
      adaptiveTeam,
      [task("t1"), task("t2", ["t1"])],
      [lead, worker("w1"), worker("w2")]
    )
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    // Both waves executed: t1 then t2 (the dependent task in a later wave).
    expect(deps._taskStatuses).toMatchObject({ t1: "completed", t2: "completed" })
  })

  it("engages the wave path when only the progress ledger is enabled (no adaptiveReplan)", async () => {
    // Progress is made each wave, so the ledger never reaches its stall judge;
    // the continue-JSON mock serves dispatch + the ledger's wrapped re-plan.
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: '```json\n{"action":"continue","reasoning":"steady"}\n```',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const ledgerTeam = {
      ...baseTeam,
      config: { ...baseTeam.config, progressLedger: { enabled: true } },
    } as AgentTeam
    const deps = buildDeps(
      ledgerTeam,
      [task("t1"), task("t2", ["t1"])],
      [lead, worker("w1"), worker("w2")]
    )
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    expect(deps._taskStatuses).toMatchObject({ t1: "completed", t2: "completed" })
  })

  it("taskFilter skips done tasks and treats them as satisfied dependencies", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    // t1 already completed in a previous run; t2 depends on it. The filter
    // (resume semantics) drops t1 — synthesis must treat the dependency as
    // externally satisfied instead of throwing invalid_dep, and t1 must not
    // be re-dispatched.
    const done = { ...task("t1"), status: "completed" as const, result: "prior result" }
    const deps = buildDeps(baseTeam, [done, task("t2", ["t1"])], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", {
      ...deps,
      taskFilter: (t) => t.status !== "completed",
    })
    expect(result.status).toBe("completed")
    expect(deps._taskStatuses).toMatchObject({ t2: "completed" })
    expect(deps._taskStatuses.t1).toBeUndefined()
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

  it("headless origin fails fast BEFORE running lead planning (no token burn)", async () => {
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", { ...deps, origin: "scheduler" })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/headless \(origin=scheduler\)/)
    // The whole point: planning must never have been invoked.
    expect(deps.runLeadPlanning).not.toHaveBeenCalled()
  })

  it("an IM triggeredFrom implies the headless policy without an explicit origin", async () => {
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", {
      ...deps,
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
    })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/headless \(origin=im\)/)
    expect(deps.runLeadPlanning).not.toHaveBeenCalled()
  })
})

describe("runTeamLifecycle — ultracode orchestration", () => {
  const fence = (json: unknown) => "```json\n" + JSON.stringify(json) + "\n```"

  // Route the (text-only, off-desktop) teammate dispatches by prompt content:
  // planner → plan, sweep finder → findings, synthesize → report.
  const wireUltracodeMock = () => {
    ;(executeAgent as jest.Mock).mockImplementation(async (prompt: string) => {
      if (prompt.includes("lead planner")) {
        return {
          text: fence({
            summary: "sweep then synthesize",
            stages: [
              { pattern: "multi-modal-sweep", instruction: "find bugs", variants: ["by-file"] },
              { pattern: "synthesize", instruction: "write report" },
            ],
          }),
        }
      }
      if (prompt.includes("Search approach")) {
        return { text: fence({ findings: [{ title: "Bug", detail: "d", location: "a.ts:1" }] }) }
      }
      if (prompt.includes("Write the final report")) {
        return { text: fence({ report: "Final report.", citations: ["a.ts:1"] }) }
      }
      return { text: "{}" }
    })
  }

  const ultracodeTeam = (): AgentTeam =>
    ({
      ...baseTeam,
      task: "Audit the payments module",
      config: {
        ...baseTeam.config,
        ultracode: { enabled: true, autoMode: "always" },
      },
    }) as AgentTeam

  it("plans, fans out patterns, and writes the synthesized report to finalResult", async () => {
    wireUltracodeMock()
    // No tasks seeded — ultracode runs off the objective string.
    const deps = buildDeps(ultracodeTeam(), [], [lead, worker("w1"), worker("w2")])
    let finalResult: string | undefined
    deps.storeWriter.setFinalResult = (_teamId, result) => {
      finalResult = result
    }

    const result = await runTeamLifecycle("team-1", deps, undefined)

    expect(result.status).toBe("completed")
    expect(finalResult).toBe("Final report.")
    // The synthesize node posted the report into the team chat.
    expect(deps._messages.some((m) => m.content === "Final report.")).toBe(true)
    // Planner + sweep finder + synthesize all dispatched through executeAgent.
    expect((executeAgent as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it("honours ultracodeOverride='off' to force the flat task DAG", async () => {
    wireUltracodeMock()
    // With override off and no tasks, the flat path fails fast — proving the
    // ultracode branch was not taken.
    const deps = buildDeps(ultracodeTeam(), [], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", { ...deps, ultracodeOverride: "off" })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/No tasks/)
  })
})

describe("runTeamLifecycle — Employee Digital Twin runtime gating", () => {
  beforeEach(() => {
    resolveTeamTwinRuntimeMock.mockClear()
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
  })

  it("builds twin deps (no recruit list) when a worker is twin-bound", async () => {
    const twinWorker = worker("w1")
    twinWorker.config = { twinId: "tw1" }
    await runTeamLifecycle("team-1", buildDeps(baseTeam, [task("t1")], [lead, twinWorker]))
    expect(resolveTeamTwinRuntimeMock).toHaveBeenCalledWith({
      buildDeps: true,
      listAvailable: false,
    })
  })

  it("builds deps + lists recruitable twins when knowledgeTwinIds + adaptiveReplan are set", async () => {
    const team = {
      ...baseTeam,
      config: {
        ...baseTeam.config,
        knowledgeTwinIds: ["tw1"],
        adaptiveReplan: { enabled: true },
      },
    } as AgentTeam
    await runTeamLifecycle("team-1", buildDeps(team, [task("t1")], [lead, worker("w1")]))
    expect(resolveTeamTwinRuntimeMock).toHaveBeenCalledWith({
      buildDeps: true,
      listAvailable: true,
    })
  })

  it("skips twin deps entirely for a plain team", async () => {
    await runTeamLifecycle("team-1", buildDeps(baseTeam, [task("t1")], [lead, worker("w1")]))
    expect(resolveTeamTwinRuntimeMock).toHaveBeenCalledWith({
      buildDeps: false,
      listAvailable: false,
    })
  })
})
