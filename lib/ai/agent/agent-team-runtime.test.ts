/**
 * Tests for the F-path synthesizer (ADR-0022, durable-only under ADR-0169).
 * The legacy in-place orchestrator was rewritten to a thin synthesizer that
 * delegates to workflow runtime. Tests below exercise the contract:
 *  - storeReader / storeWriter shape
 *  - plan-approval gate as a durable Squad review (interrupt + receipt)
 *  - terminal status mapping ({completed, failed, cancelled})
 *  - double-start prevention via inflightControllers
 *
 * Every team here carries the two bindings the coordinator requires, and the
 * Registry controller plus the environment setup executor are mocked, so the
 * durable admission path runs for real against the Dexie fixture.
 */

// The Registry workspace controller opens Bundle Turn leases through the
// native task-workspace crate. A fake keeps the durable dispatch path honest
// (leases are opened and settled) without a Registry.
jest.mock("./team/workspace/registry-controller", () => ({
  AgentTeamRegistryWorkspaceController: class FakeController {
    constructor(public readonly options: { roots: unknown[] }) {}
    async openDispatch(input: { taskId: string }) {
      return {
        primaryAlias: `/alias/${input.taskId}`,
        run: { runId: `ws-${input.taskId}` },
        settle: async () => [],
        abort: async () => undefined,
      }
    }
    getDispatchExecutionRoot() {
      return undefined
    }
    async reconcile() {
      return { mode: "manual" }
    }
  },
}))
jest.mock("@/lib/project-environment/executor", () => ({
  executeProjectEnvironment: async () => ({ success: true }),
}))
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

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  runTeamLifecycle,
  parseProposedPlan,
  __resetInflightForTesting,
  type RunTeamLifecycleDeps,
} from "./agent-team-runtime"
import { __setSquadReviewTestHooksForTesting, settleSquadReview } from "./team/squad-review-gate"
import type { SquadReviewKind } from "@/types/execution/run"
import { getTeamRunContext } from "./team/team-run-context"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"

type PlanApprovalRequest = Parameters<NonNullable<RunTeamLifecycleDeps["planApprovalDelegate"]>>[0]

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
  projectId: "project-1",
  name: "Test",
  description: "",
  task: "do a thing",
  status: "idle",
  config: {
    maxTeammates: 5,
    maxConcurrentTeammates: 2,
    executionMode: "coordinated",
    displayMode: "expanded",
    repositories: [{ id: "primary", role: "primary", path: "/repo", writable: true }],
    environmentRef: { environmentId: "env-1", versionId: "env-1:v1" },
    // The mocked executor writes no diff and runs no tests. The evidence gate
    // is exercised by `durable-dispatch.test.ts`, not here.
    evidencePolicy: {
      requireActivity: false,
      requireOutcome: false,
      requireCodeDiff: false,
      requireVerification: false,
      requireVisualForUi: false,
    },
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

const dbFixture = createDbTestFixture()

/**
 * Answer the newest pending Squad review of `kind`, the way the control plane
 * would, once it exists. Polls because the lifecycle opens the interrupt on
 * its own schedule.
 */
async function answerPendingReview(
  kind: SquadReviewKind,
  outcome: "approve" | "deny",
  extra: Record<string, unknown> = {}
): Promise<void> {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const pending = (
      await getDb().executionRunInterrupts.where("status").equals("pending").toArray()
    )
      .filter((row) => row.reviewKind === kind)
      .sort((a, b) => b.createdAt - a.createdAt)
    const row = pending[0]
    if (row) {
      const parts = row.id.split(":")
      // action-review:squad-review:<runId>:<kind>:<instance>
      const runId = parts[2]!
      const instance = parts.slice(4).join(":")
      await settleSquadReview({ runId, kind, instance }, { kind, outcome, ...extra } as never, {
        authority: "human",
        actorKind: "local-user",
      })
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`no pending ${kind} review appeared`)
}

async function pendingReviews(kind: SquadReviewKind) {
  return (await getDb().executionRunInterrupts.where("status").equals("pending").toArray()).filter(
    (row) => row.reviewKind === kind
  )
}

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowRuns.clear()
  await getDb().workflowRunEvents.clear()
  await getDb().projectEnvironmentVersions.put({
    id: "env-1:v1",
    environmentId: "env-1",
    projectId: "project-1",
    version: 1,
    name: "dev",
    setupScript: { default: "" },
    actions: [],
    variables: {},
    keyringReferences: [],
    policy: { requiredRuntimeCapabilities: [] },
    createdAt: 1,
  })
  __resetInflightForTesting()
  __setSquadReviewTestHooksForTesting({ pollIntervalMs: 10 })
  ;(executeAgent as jest.Mock).mockReset()
})

afterEach(() => {
  __resetInflightForTesting()
  __setSquadReviewTestHooksForTesting(null)
})

afterAll(dbFixture.dispose)

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
      runId: "run_team_connector_bound",
      triggeredFrom: {
        source: "im" as const,
        adapterId: "lark:a1",
        conversationKey: "lark:a1:oc_team",
        sessionId: "sess_1",
      },
    }
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    expect(result.runId).toBe("run_team_connector_bound")
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

  it("registers the parent IM permission ceiling for teammate dispatch", async () => {
    const observed: unknown[] = []
    ;(executeAgent as jest.Mock).mockImplementation(async () => {
      observed.push(getTeamRunContext("run_team_permission_ceiling")?.parentPermissionCeiling)
      return {
        text: "result",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }
    })
    const deps = {
      ...buildDeps(baseTeam, [task("t1")], [lead, worker("w1")]),
      runId: "run_team_permission_ceiling",
      parentPermissionCeiling: {
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
      },
    }

    await expect(runTeamLifecycle("team-1", deps)).resolves.toMatchObject({
      status: "completed",
    })
    expect(observed).toContainEqual({
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
    })
  })

  it("registers one Registry workspace controller for writable team repositories", async () => {
    const observed: unknown[] = []
    ;(executeAgent as jest.Mock).mockImplementation(async () => {
      observed.push(getTeamRunContext("run_team_registry")?.workspaceController)
      return {
        text: "result",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }
    })
    const registryTeam = {
      ...baseTeam,
      config: {
        ...baseTeam.config,
        workingDir: "/repo",
        workspaceIsolation: { enabled: true, baseRef: "release/1", reconcile: "manual" },
      },
    } as AgentTeam

    await expect(
      runTeamLifecycle("team-1", {
        ...buildDeps(registryTeam, [task("t1")], [lead, worker("w1")]),
        runId: "run_team_registry",
      })
    ).resolves.toMatchObject({ status: "completed" })
    expect(observed).toHaveLength(1)
    expect(observed[0]).toBeDefined()
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
    await answerPendingReview("plan", "approve")
    const result = await runPromise
    expect(result.status).toBe("completed")
  })

  it("rejects past max revisions → failed, feeding each rejection back as feedback", async () => {
    const deps = buildDeps(teamWithApproval(2), [task("t1")], [lead, worker("w1")])
    const runPromise = runTeamLifecycle("team-1", deps)
    await answerPendingReview("plan", "deny", { feedback: "no good" })
    await answerPendingReview("plan", "deny", { feedback: "still no" })
    const result = await runPromise
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/rejected/)
    const planning = deps.runLeadPlanning as jest.Mock
    expect(planning).toHaveBeenCalledTimes(2)
    expect(planning.mock.calls[1]?.[0]).toMatchObject({ feedback: "no good" })
    // Two revisions, two durable interrupts, both settled, both receipted.
    const rows = await getDb().executionRunInterrupts.toArray()
    expect(rows.map((row) => row.status).sort()).toEqual(["denied", "denied"])
    expect(await getDb().actionReviewReceipts.count()).toBe(2)
  })

  it("publishes the plan to the board lead and opens the plan gate before waiting", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    const updateTeammate = jest.fn()
    deps.storeWriter.updateTeammate = updateTeammate

    const runPromise = runTeamLifecycle("team-1", deps)
    const deadline = Date.now() + 4_000
    while ((await pendingReviews("plan")).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }

    // While the gate is waiting: the lead carries the proposed plan and the
    // awaiting_approval status the coordination panel renders on, and ONE
    // durable interrupt parks the execution run on the plan decision.
    expect(updateTeammate).toHaveBeenCalledWith("lead-1", {
      status: "awaiting_approval",
      proposedPlan: expect.stringContaining("summary"),
    })
    const [interrupt] = await pendingReviews("plan")
    expect(interrupt).toMatchObject({
      type: "plan_approval",
      reviewKind: "plan",
      subject: { revision: 0, maxRevisions: 3 },
    })
    const parked = await getDb().executionRuns.get(interrupt!.runId)
    expect(parked?.status).toBe("waiting")
    expect(parked?.latestSnapshot?.allowedActions).toEqual(
      expect.arrayContaining(["approve", "deny"])
    )

    await answerPendingReview("plan", "approve")
    const result = await runPromise
    expect(result.status).toBe("completed")
    // Decision received → the lead must leave awaiting_approval.
    expect(updateTeammate).toHaveBeenCalledWith("lead-1", { status: "idle" })
  })

  it("resets the lead out of awaiting_approval when the plan is rejected", async () => {
    const deps = buildDeps(teamWithApproval(1), [task("t1")], [lead, worker("w1")])
    const updateTeammate = jest.fn()
    deps.storeWriter.updateTeammate = updateTeammate

    const runPromise = runTeamLifecycle("team-1", deps)
    await answerPendingReview("plan", "deny", { feedback: "no good" })
    const result = await runPromise
    expect(result.status).toBe("failed")
    expect(updateTeammate).toHaveBeenCalledWith("lead-1", { status: "idle" })
  })

  it("fails fast when runLeadPlanning dep is missing", async () => {
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    delete (deps as { runLeadPlanning?: unknown }).runLeadPlanning
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/runLeadPlanning/)
  })

  it("fails the run (not the process) when lead planning throws", async () => {
    // Regression: this await was bare, so a lead that could not resolve a
    // provider — the default state before the provider fix — rejected straight
    // out of runTeamLifecycle instead of returning a failed run the operator
    // can see. Every neighbouring failure in this block returns a result.
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    deps.runLeadPlanning = jest.fn(async () => {
      throw new Error("The team lead has no AI provider to run on: …Settings → Providers…")
    })

    const result = await runTeamLifecycle("team-1", deps)

    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/Settings → Providers/)
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

describe("runTeamLifecycle — risk-raised plan approval (ADR-0070)", () => {
  /** A roster that can drive the machine: computer-use → high risk. */
  const riskyWorker = () =>
    ({ ...worker("w1"), config: { tools: ["computer_use"] } }) as AgentTeammate

  it("raises the plan-approval gate for a high-risk roster even with requirePlanApproval=false", async () => {
    expect(baseTeam.config.requirePlanApproval).toBeFalsy()
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])
    const updateTeammate = jest.fn()
    deps.storeWriter.updateTeammate = updateTeammate

    const runPromise = runTeamLifecycle("team-1", deps)
    const deadline = Date.now() + 4_000
    while ((await pendingReviews("plan")).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    // The gate is live: the lead is parked awaiting approval with a plan, and
    // the interrupt names the risk that raised it.
    expect(deps.runLeadPlanning).toHaveBeenCalled()
    expect(updateTeammate).toHaveBeenCalledWith(
      "lead-1",
      expect.objectContaining({ status: "awaiting_approval" })
    )
    expect((await pendingReviews("plan"))[0]?.subject).toMatchObject({
      riskReason: expect.any(String),
    })
    await answerPendingReview("plan", "deny", { feedback: "not today" })
    const result = await runPromise
    expect(result.status).toBe("failed")
  })

  it("names the risk surfaces when the same run is headless", async () => {
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])
    const result = await runTeamLifecycle("team-1", { ...deps, origin: "scheduler" })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/computer-use/)
    expect(result.reason).toMatch(/cannot proceed unattended \(origin=scheduler\)/)
    // Fail-fast means fail BEFORE burning planning tokens.
    expect(deps.runLeadPlanning).not.toHaveBeenCalled()
  })

  it("riskGating=false restores the old unattended behavior", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const optedOut = { ...baseTeam, config: { ...baseTeam.config, riskGating: false } }
    const deps = buildDeps(optedOut, [task("t1")], [lead, riskyWorker()])
    const result = await runTeamLifecycle("team-1", { ...deps, origin: "scheduler" })
    expect(result.status).toBe("completed")
    expect(deps.runLeadPlanning).not.toHaveBeenCalled()
  })

  it("leaves a low-risk roster completely alone", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    // No plan, no gate, no new friction — the Quick lane is untouched.
    expect(deps.runLeadPlanning).not.toHaveBeenCalled()
  })

  it("does not gate a plain IM-bound run — being connector-bound is not itself a risk", async () => {
    // Regression guard for the `startTeamRunFromIM` production flow: judging a
    // run by its origin (rather than by what its roster can reach) would make
    // every headless IM-bound team run fail-fast. See ADR-0070 §Rejected.
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
    })
    expect(result.status).toBe("completed")
  })

  it("DOES gate an IM-bound run whose roster can drive the machine", async () => {
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])
    const result = await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
    })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/computer-use/)
  })

  it("still explains an operator-set gate by the operator's choice, not by risk", async () => {
    const operatorGated = {
      ...baseTeam,
      config: { ...baseTeam.config, requirePlanApproval: true },
    }
    const deps = buildDeps(operatorGated, [task("t1")], [lead, riskyWorker()])
    const result = await runTeamLifecycle("team-1", { ...deps, origin: "scheduler" })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/requirePlanApproval is enabled/)
  })
})

describe("runTeamLifecycle — an attended headless run asks instead of failing", () => {
  /** Same roster the risk suite uses: computer-use → high risk. */
  const riskyWorker = () =>
    ({ ...worker("w1"), config: { tools: ["computer_use"] } }) as AgentTeammate

  it("asks through the run's own surface when the caller supplies a channel", async () => {
    // `origin: "im"` alone put this under the headless policy, whose plan gate
    // fails fast on the premise that there is no human. A chat thread with a
    // person in it and a working approval channel makes that premise false.
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const planApprovalDelegate = jest.fn(async (_request: PlanApprovalRequest) => ({
      outcome: "approve" as const,
    }))
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])

    const result = await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
      planApprovalDelegate,
    })

    expect(planApprovalDelegate).toHaveBeenCalledWith(
      expect.objectContaining({ planText: expect.any(String), revision: 0 })
    )
    expect(result.status).toBe("completed")
  })

  it("names the risk to the person being asked, since risk is what raised the gate", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const planApprovalDelegate = jest.fn(async (_request: PlanApprovalRequest) => ({
      outcome: "approve" as const,
    }))
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])

    await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
      planApprovalDelegate,
    })

    expect(planApprovalDelegate.mock.calls[0]?.[0]).toMatchObject({
      riskReason: expect.stringContaining("computer-use"),
    })
  })

  it("feeds a rejection back into the lead's re-planning loop", async () => {
    const planApprovalDelegate = jest.fn(async (_request: PlanApprovalRequest) => ({
      outcome: "reject" as const,
      feedback: "split it up",
    }))
    const deps = buildDeps(
      { ...baseTeam, config: { ...baseTeam.config, maxPlanRevisions: 2 } },
      [task("t1")],
      [lead, riskyWorker()]
    )
    const runLeadPlanning = jest.fn(deps.runLeadPlanning!)
    deps.runLeadPlanning = runLeadPlanning

    const result = await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
      planApprovalDelegate,
    })

    expect(runLeadPlanning).toHaveBeenCalledTimes(2)
    expect(runLeadPlanning.mock.calls[1]?.[0]).toMatchObject({ feedback: "split it up" })
    expect(result.status).toBe("failed")
  })

  it("still fails fast when the caller has no channel to ask through", async () => {
    // The default is no channel, so every existing caller keeps today's
    // behaviour byte for byte — claiming a channel one cannot service would
    // turn a loud failure into a silent hang.
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])
    const result = await runTeamLifecycle("team-1", { ...deps, origin: "im" })
    expect(result.status).toBe("failed")
  })

  it("lets the operator's autonomy raise the gate on a run risk would not have gated", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const planApprovalDelegate = jest.fn(async (_request: PlanApprovalRequest) => ({
      outcome: "approve" as const,
    }))
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])

    await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
      requirePlanApprovalFloor: true,
      planApprovalDelegate,
    })

    expect(planApprovalDelegate).toHaveBeenCalled()
    // Not risk — so the card must not blame the roster for the operator's choice.
    expect(planApprovalDelegate.mock.calls[0]?.[0]).not.toHaveProperty("riskReason")
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
