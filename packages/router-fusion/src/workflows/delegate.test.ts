import {
  CONTRACT_SCHEMA_VERSION,
  RunResultSchema,
  SubtaskSchema,
  WorkerResultSchema,
  type VerificationReport,
} from "../contracts/schemas"
import { DEFAULT_LIMITS_BY_MODE } from "../config/builtin-catalog"
import {
  MemoryAcceptancePort,
  junitFixture,
  type MemoryAcceptanceScript,
} from "../fake/memory-acceptance"
import { MemoryApprovalPort } from "../fake/memory-approvals"
import { MemoryArtifactStore } from "../fake/memory-artifacts"
import {
  MemoryDelegateToolRuntime,
  type MemoryDelegateToolOptions,
} from "../fake/memory-delegate-tools"
import { FAKE_SEMANTICS, FakeProvider, type FakeStep } from "../fake/fake-provider"
import { MemoryCallLedger } from "../fake/memory-ledger"
import { SPEC_MOCK_REGISTRY } from "../fake/mock-registry"
import { MemoryStepJournal } from "../fake/memory-step-journal"
import { MemoryWorkspace } from "../fake/memory-workspace"
import { uuidFromName } from "../util/sha256"
import { BudgetRefusedError, WorkflowError } from "./durable-call"
import {
  DELEGATE_WORK_POLICY,
  DelegatePatchSchema,
  delegateApprovalDigest,
  type ApprovalPort,
  type DelegatePatch,
} from "./delegate-ports"
import {
  DELEGATE_CORE_STAGE,
  delegateLimitsOf,
  runDelegateWorkflow,
  type DelegateRunInput,
  type DelegateRunOutcome,
  type DelegateRunPorts,
} from "./delegate"
import type { RoleCallExecutor, RoleCallRequest, WorkflowEvent } from "./ports"
import { runTimelineOf } from "./run-timeline"

// ── the scripted provider ─────────────────────────────────────────────────────

type Step =
  | FakeStep
  /** Several tool requests in one turn (the Fake Provider scripts one per step). */
  | { kind: "tools"; calls: Array<{ name: string; arguments: Record<string, unknown> }> }

function scripted(steps: Record<string, Step[]>) {
  const seen: Record<string, number> = {}
  let current: Step = { kind: "text", text: "" }
  const fake = new FakeProvider(() => current as FakeStep)
  const requests: RoleCallRequest[] = []
  const executor: RoleCallExecutor = {
    async call(request, signal) {
      requests.push(request)
      const list = steps[request.role] ?? [{ kind: "text", text: `unscripted ${request.role}` }]
      const index = seen[request.role] ?? 0
      seen[request.role] = index + 1
      current = list[Math.min(index, list.length - 1)]
      if (current.kind === "tools") {
        return {
          outcome: "ok",
          text: "",
          usage: { inputTokens: 40, outputTokens: 8 },
          semantics: FAKE_SEMANTICS,
          providerRequestId: `mock:${request.attemptId}`,
          finishReason: "tool_calls",
          toolCalls: current.calls.map((call, i) => ({
            id: `${request.attemptId}:tool:${i}`,
            ...call,
          })),
        }
      }
      return fake.call(request, signal)
    },
  }
  return { executor, requests }
}

const draft = (overrides: Record<string, unknown> = {}) => ({
  goal: "Fix the pagination race in the users list",
  allowed_paths: ["src/users", "./tests/users/"],
  constraints: ["do not change the backend API"],
  acceptance: ["the race-condition test passes"],
  max_steps: 6,
  ...overrides,
})

const plan = (overrides: Record<string, unknown> = {}): Step => ({
  kind: "json",
  value: { status: "ready", subtasks: [draft()], questions: [], ...overrides },
})

const done = (overrides: Record<string, unknown> = {}): Step => ({
  kind: "json",
  value: {
    status: "completed",
    summary: "Guarded the list refresh with a request token.",
    claimed_check_ids: [],
    open_questions: [],
    ...overrides,
  },
})

const write = (path: string, content: string): Step => ({
  kind: "tool_call",
  name: "propose_patch",
  arguments: { path, action: "write", content },
})

const read = (path: string): Step => ({
  kind: "tool_call",
  name: "workspace_read",
  arguments: { path },
})

/** One work session: propose a fix, then report. */
const session = (content = "export const list = guarded([])\n"): Step[] => [
  write("src/users/list.ts", content),
  done(),
]

const taskIdOf = (index: number) => uuidFromName(`run-delegate-1|delegate|subtask|${index}`)

// ── acceptance scripts ────────────────────────────────────────────────────────

const PASS_XML = junitFixture([
  { name: "lists users", status: "passed" },
  { name: "race condition", status: "passed" },
])
const FAIL_XML = junitFixture([
  { name: "lists users", status: "passed" },
  { name: "race condition", status: "failed", message: "expected 2 rows, got 3" },
])

const passing: MemoryAcceptanceScript = () => ({
  kind: "execution",
  exitCode: 0,
  report: { format: "junit", content: PASS_XML },
})
const failing: MemoryAcceptanceScript = () => ({
  kind: "execution",
  exitCode: 1,
  report: { format: "junit", content: FAIL_XML },
})

// ── the world ─────────────────────────────────────────────────────────────────

const FILES = {
  "src/users/list.ts": "export const list = []\n",
  "tests/users/list.test.ts": "test('race condition', () => {})\n",
  "config/app.json": '{"pageSize": 20}\n',
  "README.md": "# fixture\n",
}

interface WorldOptions {
  acceptance?: MemoryAcceptanceScript
  approvals?: ApprovalPort
  approvalPolicy?: ConstructorParameters<typeof MemoryApprovalPort>[0]
  cap?: number
  maxModelCalls?: number
  tools?: MemoryDelegateToolOptions
  workspace?: MemoryWorkspace
}

function world(steps: Record<string, Step[]>, options: WorldOptions = {}) {
  const { executor, requests } = scripted(steps)
  const ledger = new MemoryCallLedger({
    capMicrousd: options.cap ?? 5_000_000,
    maxModelCalls: options.maxModelCalls ?? 24,
    deployments: Object.fromEntries(SPEC_MOCK_REGISTRY.deployments.map((d) => [d.id, d])),
    rateCards: Object.fromEntries(SPEC_MOCK_REGISTRY.rate_cards.map((c) => [c.id, c])),
  })
  let id = 0
  const newId = () => `77777777-7777-4777-8777-${String(++id).padStart(12, "0")}`
  const artifacts = new MemoryArtifactStore()
  const workspace = options.workspace ?? new MemoryWorkspace(FILES)
  const tools = new MemoryDelegateToolRuntime(workspace, artifacts, options.tools)
  const acceptance = new MemoryAcceptancePort(options.acceptance ?? passing, newId)
  const memoryApprovals = new MemoryApprovalPort(options.approvalPolicy)
  const journal = new MemoryStepJournal()
  const events: WorkflowEvent[] = []
  const ports: DelegateRunPorts = {
    ledger,
    executor,
    events: { emit: async (event) => void events.push(event) },
    clock: { now: () => 0 },
    sleep: async () => undefined,
    artifacts,
    newId,
    tools,
    workspace,
    acceptance,
    approvals: options.approvals ?? memoryApprovals,
    journal,
  }
  return {
    ports,
    requests,
    ledger,
    artifacts,
    workspace,
    tools,
    acceptance,
    approvals: memoryApprovals,
    journal,
    events,
  }
}

function input(overrides: Partial<DelegateRunInput> = {}): DelegateRunInput {
  return {
    runId: "run-delegate-1",
    lead: { deploymentId: "fake-baseline", contextLimit: 65_536 },
    worker: { deploymentId: "fake-economy", contextLimit: 65_536 },
    messages: [
      {
        role: "user",
        content: "Fix the pagination race in the users list and keep the tests green.",
      },
    ],
    acceptanceProfileId: "unit",
    outputTokens: { lead: 1_024, worker: 1_024, reviewer: 512 },
    reserveFor: () => 5_000,
    limits: delegateLimitsOf(DEFAULT_LIMITS_BY_MODE.delegate),
    task: "code.debug",
    allowDegraded: false,
    delivery: "patch_only",
    deadlineAt: 1_000_000,
    signal: new AbortController().signal,
    ...overrides,
  }
}

const noEscalation = {
  ...delegateLimitsOf(DEFAULT_LIMITS_BY_MODE.delegate),
  workerRepairRounds: 0,
  leadTakeovers: 0,
}

async function failure(promise: Promise<unknown>): Promise<WorkflowError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof WorkflowError) return error
    throw error
  }
  throw new Error("expected the workflow to fail")
}

function completed(outcome: DelegateRunOutcome) {
  if (outcome.kind !== "completed") throw new Error(`expected completed, got ${outcome.kind}`)
  return outcome
}

function waiting(outcome: DelegateRunOutcome) {
  if (outcome.kind !== "waiting_for_approval")
    throw new Error(`expected waiting, got ${outcome.kind}`)
  return outcome
}

function toolSteps(w: ReturnType<typeof world>) {
  return w.tools.executed.map((entry) => [entry.context.logicalStepId, entry.context.revision])
}

// ── the graph ─────────────────────────────────────────────────────────────────

describe("runDelegateWorkflow", () => {
  it("plans, works, verifies the staged revision and delivers the patch without touching the workspace", async () => {
    const w = world({ lead: [plan({ subtasks: [draft({ max_steps: 20 })] })], worker: session() })
    const outcome = completed(await runDelegateWorkflow(w.ports, input()))

    expect(w.requests.map((r) => r.role)).toEqual(["lead", "worker", "worker"])
    expect(w.ledger.state.modelCalls).toBe(3)
    // The subtask is the server's: base revision, policy, ids and bounds are not the model's.
    expect(outcome.subtasks).toHaveLength(1)
    const subtask = SubtaskSchema.parse(outcome.subtasks[0])
    expect(subtask).toMatchObject({
      task_id: taskIdOf(1),
      base_revision: "rev-0",
      allowed_paths: ["src/users", "tests/users"],
      tool_policy_id: DELEGATE_WORK_POLICY,
      max_steps: 8,
      artifact_namespace: "runs/run-delegate-1/delegate/subtask-1",
    })
    expect(subtask.acceptance[0]).toBe("profile:unit")

    // Verified on the staged revision, never the user's checkout.
    const staged = w.workspace.staged[0]
    expect(w.acceptance.runs).toEqual([
      { profileId: "unit", revision: staged.revision, logicalStepId: "delegate:verify:1" },
    ])
    expect(w.workspace.current).toBe("rev-0")
    expect(w.workspace.applied).toEqual([])
    expect(w.workspace.filesAt(staged.revision)?.["src/users/list.ts"]).toBe(
      "export const list = guarded([])\n"
    )

    const result = RunResultSchema.parse(outcome.result)
    expect(result).toMatchObject({
      mode_executed: "delegate",
      delivery: "patch_only",
      quality_status: "accepted",
      answer: "Guarded the list refresh with a request token.",
      verification: { status: "passed", level: "tool_verified", revision: staged.revision },
    })
    expect(outcome.workerResults).toHaveLength(1)
    const worker = WorkerResultSchema.parse(outcome.workerResult)
    expect(worker).toMatchObject({
      task_id: taskIdOf(1),
      base_revision: "rev-0",
      result_revision: staged.revision,
    })
    expect(outcome).toMatchObject({
      resultRevision: staged.revision,
      deliveredRevision: null,
      sandboxTier: "container",
      repairs: 0,
      takeovers: 0,
      turns: 2,
      toolOperations: 1,
    })
    expect(outcome.verifications).toEqual([
      {
        round: 1,
        revision: staged.revision,
        status: "passed",
        reason: null,
        reportId: expect.any(String),
        sandboxTier: "container",
        review: null,
      },
    ])
    expect(result.artifact_ids).toContain(outcome.patchArtifactId)
    const patch = DelegatePatchSchema.parse(
      JSON.parse((await w.artifacts.get(outcome.patchArtifactId))!.content)
    ) as DelegatePatch
    expect(patch.base_revision).toBe("rev-0")
    expect(patch.files.map((f) => [f.path, f.action])).toEqual([["src/users/list.ts", "write"]])
    expect(result.verification.checks.find((c) => c.check_id === "sandbox")?.summary).toBe(
      "tier=container"
    )
    // The core stage is given back whatever the outcome.
    expect(w.ledger.stages.get(DELEGATE_CORE_STAGE)?.state).not.toBe("held")
  })

  it("runs a plan's subtasks in order on the evolving revision and verifies the combined result once", async () => {
    const w = world({
      lead: [
        plan({
          subtasks: [
            draft(),
            draft({
              goal: "Cover the fix with a test",
              allowed_paths: ["tests/users"],
              constraints: [],
              acceptance: ["the new test runs"],
              max_steps: 4,
            }),
          ],
        }),
      ],
      worker: [
        write("src/users/list.ts", "guarded\n"),
        done({ summary: "Guarded the refresh." }),
        read("src/users/list.ts"),
        write("tests/users/list.test.ts", "test('race', () => {})\n"),
        done({ summary: "Covered it with a test." }),
      ],
    })
    const outcome = completed(await runDelegateWorkflow(w.ports, input()))

    const [first, second] = w.workspace.staged.map((entry) => entry.revision)
    expect(outcome.subtasks.map((s) => [s.task_id, s.base_revision, s.allowed_paths])).toEqual([
      [taskIdOf(1), "rev-0", ["src/users", "tests/users"]],
      [taskIdOf(2), first, ["tests/users"]],
    ])
    // Subtask 2 reads what subtask 1 produced, and stages on top of it.
    expect(toolSteps(w)).toEqual([
      ["delegate:s1:work:1:turn:1", "rev-0"],
      ["delegate:s2:work:2:turn:1", first],
      ["delegate:s2:work:2:turn:2", first],
    ])
    expect(w.workspace.filesAt(first)).toMatchObject({ "src/users/list.ts": "guarded\n" })
    expect(w.workspace.filesAt(second)).toMatchObject({
      "src/users/list.ts": "guarded\n",
      "tests/users/list.test.ts": "test('race', () => {})\n",
    })
    // One acceptance run, on the final combined revision.
    expect(w.acceptance.runs.map((r) => r.revision)).toEqual([second])
    expect(outcome.resultRevision).toBe(second)

    // A WorkerResult per subtask, chained: each starts where the last ended.
    const [wr1, wr2] = outcome.workerResults
    expect(wr1).toMatchObject({
      task_id: taskIdOf(1),
      base_revision: "rev-0",
      result_revision: first,
    })
    expect(wr2).toMatchObject({
      task_id: taskIdOf(2),
      base_revision: first,
      result_revision: second,
    })
    const ownPatch = async (id: string) =>
      DelegatePatchSchema.parse(JSON.parse((await w.artifacts.get(id))!.content))
    expect(await ownPatch(wr1.patch_artifact_id)).toMatchObject({
      base_revision: "rev-0",
      files: [{ path: "src/users/list.ts" }],
    })
    expect(await ownPatch(wr2.patch_artifact_id)).toMatchObject({
      base_revision: first,
      files: [{ path: "tests/users/list.test.ts" }],
    })
    // The delivered patch is the combined change against the run's base.
    const combined = await ownPatch(outcome.patchArtifactId)
    expect(combined).toMatchObject({ base_revision: "rev-0" })
    expect(combined.files.map((f) => f.path)).toEqual([
      "src/users/list.ts",
      "tests/users/list.test.ts",
    ])
    expect(outcome.result.answer).toBe("Guarded the refresh.\n\nCovered it with a test.")
    expect(outcome.result.warnings).toContain("subtasks:2")
    // The run's counters are shared by both subtasks.
    expect(outcome).toMatchObject({ turns: 5, toolOperations: 3, repairs: 0, takeovers: 0 })
    expect(runTimelineOf(w.events.map((e, i) => ({ ...e, at: i }))).delegate).toMatchObject({
      subtasks: { planned: 2, completed: 2 },
      attempts: 2,
      workerTurns: 5,
      toolOperations: 3,
      delivery: "patch_only",
    })
    expect(outcome.result.verification.checks.find((c) => c.check_id === "subtasks")?.summary).toBe(
      `staged=2 final=${second}`
    )
  })

  it("repairs the subtask that failed, not the ones that already passed", async () => {
    const w = world({
      lead: [
        plan({
          subtasks: [
            draft(),
            draft({ goal: "Cover it", allowed_paths: ["tests/users"], max_steps: 3 }),
          ],
        }),
      ],
      worker: [
        write("src/users/list.ts", "guarded\n"),
        done({ summary: "Guarded." }),
        done({ status: "blocked", summary: "The test file is generated." }),
        write("tests/users/list.test.ts", "test('race', () => {})\n"),
        done({ summary: "Wrote the test by hand." }),
      ],
    })
    const outcome = completed(
      await runDelegateWorkflow(
        w.ports,
        input({ limits: { ...noEscalation, workerRepairRounds: 1 } })
      )
    )
    expect(outcome.attempts.map((a) => [a.subtask, a.kind, a.outcome, a.reason])).toEqual([
      [1, "work", "staged", null],
      [2, "work", "blocked", "WORKER_BLOCKED"],
      [2, "repair", "staged", null],
    ])
    expect(outcome.repairs).toBe(1)
    // Subtask 1 is never redone, and the failure report reaches the repair.
    expect(toolSteps(w).map(([step]) => step)).toEqual([
      "delegate:s1:work:1:turn:1",
      "delegate:s2:repair:3:turn:1",
    ])
    expect(w.requests[4].messages.map((m) => m.content).join("\n")).toContain(
      "The test file is generated."
    )
    expect(w.acceptance.runs).toHaveLength(1)
    expect(outcome.result.warnings).toEqual(expect.arrayContaining(["subtasks:2", "repaired:1"]))
  })

  it("fails the run when a subtask cannot finish and no repair or takeover is left", async () => {
    const w = world({
      lead: [
        plan({ subtasks: [draft(), draft({ goal: "second", allowed_paths: ["tests/users"] })] }),
      ],
      worker: [...session(), done({ status: "blocked", summary: "cannot." })],
    })
    const error = await failure(runDelegateWorkflow(w.ports, input({ limits: noEscalation })))
    expect(error.code).toBe("VERIFICATION_FAILED")
    expect(error.details).toMatchObject({
      subtask: 2,
      subtasks: 2,
      last_outcome: "blocked",
      last_reason: "WORKER_BLOCKED",
    })
    // Nothing is verified when the plan never finished.
    expect(w.acceptance.runs).toEqual([])
  })

  it("shares the run's turns and tool operations across subtasks, and stops when they are spent", async () => {
    const twoSubtasks = {
      subtasks: [draft(), draft({ goal: "second", allowed_paths: ["tests/users"], max_steps: 6 })],
    }
    const turns = world({
      lead: [plan(twoSubtasks)],
      worker: [
        write("src/users/list.ts", "guarded\n"),
        done(),
        write("tests/users/list.test.ts", "t\n"),
        done(),
      ],
    })
    const error = await failure(
      runDelegateWorkflow(
        turns.ports,
        input({ limits: { ...noEscalation, workerModelTurns: 3, workerRepairRounds: 1 } })
      )
    )
    // Subtask 1 spent two of the run's three turns; subtask 2 got the last one
    // (no tools on a last turn), could not finish, and no turn is left to repair.
    expect(error.code).toBe("DELEGATE_LIMIT_EXHAUSTED")
    expect(error.details).toMatchObject({
      limit: "worker_model_turns",
      used: 3,
      cap: 3,
      subtask: 2,
    })
    expect(turns.requests.filter((r) => r.role === "worker")).toHaveLength(3)
    expect(turns.acceptance.runs).toEqual([])

    const ops = world({
      lead: [plan(twoSubtasks)],
      worker: [
        write("src/users/list.ts", "guarded\n"),
        done(),
        write("tests/users/list.test.ts", "t\n"),
        done(),
      ],
    })
    completed(
      await runDelegateWorkflow(
        ops.ports,
        input({ limits: { ...noEscalation, workerToolOperations: 1 } })
      )
    )
    // The one tool operation of the run went to subtask 1; subtask 2 is offered none.
    expect(ops.tools.executed).toHaveLength(1)
    const workerCalls = ops.requests.filter((r) => r.role === "worker")
    expect(workerCalls.map((r) => r.tools?.length ?? 0)).toEqual([3, 0, 0, 0])
    expect(ops.workspace.staged.map((s) => s.patch.files.map((f) => f.path))).toEqual([
      ["src/users/list.ts"],
      ["src/users/list.ts"],
    ])
  })

  it("is reachable through the package entry point", async () => {
    const pkg = await import("../index")
    expect(pkg.runDelegateWorkflow).toBe(runDelegateWorkflow)
    expect(pkg.delegateLimitsOf(DEFAULT_LIMITS_BY_MODE.delegate)).toEqual({
      maxSubtasks: 4,
      workerModelTurns: 8,
      workerToolOperations: 12,
      workerRepairRounds: 1,
      leadTakeovers: 1,
      maxFormatRepairs: 1,
      transportAttempts: 2,
    })
  })

  // ── DEL-01 ──

  it("[ACC:DEL-01] never lets a worker's 'all tests pass' verify anything without a runtime report", async () => {
    const modelSays: VerificationReport = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      report_id: "99999999-9999-4999-8999-000000000001",
      status: "passed",
      level: "model_review",
      checks: [
        {
          check_id: "all_tests",
          kind: "tests",
          status: "passed",
          summary: "the worker says all tests pass",
          executed_by: "model",
          artifact_refs: [],
        },
      ],
      revision: null,
      verifier_version: "worker-claim",
      artifact_refs: [],
    }
    const claim = done({
      summary: "All tests pass.",
      claimed_check_ids: ["unit:all", "tool_verified"],
    })
    const steps = { lead: [plan()], worker: [write("src/users/list.ts", "x\n"), claim] }

    // Refused outright when the request did not allow a degraded result.
    const strict = world(steps, {
      acceptance: ({ revision }) => ({ kind: "raw", report: { ...modelSays, revision } }),
    })
    const error = await failure(runDelegateWorkflow(strict.ports, input({ limits: noEscalation })))
    expect(error.code).toBe("VERIFICATION_INCONCLUSIVE")
    expect(error.details).toMatchObject({ last_reason: "NOT_TOOL_VERIFIED" })

    // Allowed to degrade: delivered as unverified, never tool_verified, never accepted.
    const lenient = world(steps, {
      acceptance: ({ revision }) => ({ kind: "raw", report: { ...modelSays, revision } }),
    })
    const outcome = completed(
      await runDelegateWorkflow(lenient.ports, input({ limits: noEscalation, allowDegraded: true }))
    )
    expect(outcome.result.quality_status).toBe("degraded")
    expect(outcome.result.verification.level).toBe("schema_only")
    expect(outcome.result.verification.status).toBe("inconclusive")
    const checks = outcome.result.verification.checks
    expect(checks.some((c) => c.executed_by === "model")).toBe(false)
    expect(checks.find((c) => c.check_id === "worker_claims")).toMatchObject({
      status: "not_applicable",
      summary: expect.stringContaining("claimed=2"),
    })
    expect(checks.find((c) => c.check_id === "acceptance_verdict")?.summary).toContain(
      "reason=NOT_TOOL_VERIFIED"
    )
    expect(outcome.workerResult.claimed_check_ids).toEqual(["unit:all", "tool_verified"])
    expect(outcome.result.warnings).toEqual(
      expect.arrayContaining([
        "worker_claims_not_counted",
        "verification_inconclusive:NOT_TOOL_VERIFIED",
      ])
    )

    // A claim beside a real, failing runtime report changes nothing: it fails.
    const contradicted = world(steps, { acceptance: failing })
    const refuted = await failure(
      runDelegateWorkflow(contradicted.ports, input({ limits: noEscalation, allowDegraded: true }))
    )
    expect(refuted.code).toBe("VERIFICATION_FAILED")
    expect(refuted.details).toMatchObject({ last_reason: "ACCEPTANCE_FAILED" })
  })

  // ── DEL-02 ──

  it("[ACC:DEL-02] fails a green exit that discovered no test, or skipped them all", async () => {
    const empty = world(
      { lead: [plan()], worker: session() },
      {
        acceptance: () => ({
          kind: "execution",
          exitCode: 0,
          report: {
            format: "junit",
            content: '<testsuites tests="0"><testsuite name="unit" tests="0"/></testsuites>',
          },
        }),
      }
    )
    const none = await failure(runDelegateWorkflow(empty.ports, input({ limits: noEscalation })))
    expect(none.code).toBe("VERIFICATION_FAILED")
    const verified = empty.events.find((e) => e.type === "verification.completed")
    expect(verified?.payload).toMatchObject({ status: "failed", level: "tool_verified", round: 1 })

    const skipped = world(
      { lead: [plan()], worker: session() },
      {
        acceptance: () => ({
          kind: "execution",
          exitCode: 0,
          report: {
            format: "json",
            content: JSON.stringify({
              tests: [
                { id: "race", status: "skipped" },
                { id: "list", status: "skipped" },
              ],
            }),
          },
        }),
      }
    )
    const all = await failure(
      runDelegateWorkflow(skipped.ports, input({ limits: noEscalation, allowDegraded: true }))
    )
    // Failed, not inconclusive: even a degradable request gets nothing delivered.
    expect(all.code).toBe("VERIFICATION_FAILED")
  })

  // ── DEL-03 ──

  it("[ACC:DEL-03] never lets a report about another revision verify the delivered one", async () => {
    const stale = world(
      { lead: [plan()], worker: session() },
      {
        acceptance: () => ({
          kind: "execution",
          exitCode: 0,
          report: { format: "junit", content: PASS_XML },
          reportRevision: "rev-0",
        }),
      }
    )
    const error = await failure(runDelegateWorkflow(stale.ports, input({ limits: noEscalation })))
    expect(error.code).toBe("VERIFICATION_INCONCLUSIVE")
    expect(error.details).toMatchObject({ last_reason: "REVISION_MISMATCH" })
  })

  it("[ACC:DEL-03] a pass on v1 does not carry over when a repair produces v2", async () => {
    let revisions: string[] = []
    const w = world(
      {
        lead: [plan()],
        worker: [
          write("src/users/list.ts", "v1\n"),
          done(),
          write("src/users/list.ts", "v2\n"),
          done(),
        ],
        reviewer: [
          { kind: "json", value: { status: "failed", issues: ["handles only one page"] } },
        ],
      },
      {
        acceptance: ({ revision, run }) => {
          revisions = [...revisions, revision]
          // v1 genuinely passes; for v2 the sandbox hands back v1's report.
          return {
            kind: "execution",
            exitCode: 0,
            report: { format: "junit", content: PASS_XML },
            ...(run === 1 ? { reportRevision: revisions[0] } : {}),
          }
        },
      }
    )
    const outcome = completed(
      await runDelegateWorkflow(
        w.ports,
        input({
          reviewer: { deploymentId: "fake-independent", contextLimit: 65_536 },
          limits: { ...noEscalation, workerRepairRounds: 1 },
          allowDegraded: true,
        })
      )
    )
    const [v1, v2] = revisions
    expect(v1).not.toBe(v2)
    expect(outcome.resultRevision).toBe(v2)
    expect(outcome.result.verification.revision).toBe(v2)
    expect(outcome.result.verification.status).toBe("inconclusive")
    expect(outcome.result.verification.level).not.toBe("tool_verified")
    expect(outcome.result.quality_status).toBe("degraded")
    expect(
      outcome.result.verification.checks.find((c) => c.check_id === "revision_match")
    ).toMatchObject({ status: "inconclusive", summary: `report=${v1} result=${v2}` })
    expect(outcome.verifications.map((v) => [v.status, v.reason])).toEqual([
      ["failed", "REVIEW_FAILED"],
      ["inconclusive", "REVISION_MISMATCH"],
    ])
  })

  // ── DEL-06 ──

  it("[ACC:DEL-06] gives a failing run exactly one repair and one takeover, then fails", async () => {
    const w = world(
      {
        lead: [plan(), ...session("lead attempt\n")],
        worker: [...session(), ...session("repair\n")],
      },
      { acceptance: failing }
    )
    const error = await failure(runDelegateWorkflow(w.ports, input()))

    expect(error.code).toBe("VERIFICATION_FAILED")
    expect(error.details).toMatchObject({
      round: 3,
      attempts: 3,
      repairs: 1,
      takeovers: 1,
      last_reason: "ACCEPTANCE_FAILED",
    })
    // PLAN (1) + WORK (2) + REPAIR (2) + TAKEOVER (2), and nothing more.
    expect(w.requests.map((r) => r.role)).toEqual([
      "lead",
      "worker",
      "worker",
      "worker",
      "worker",
      "lead",
      "lead",
    ])
    expect(w.ledger.state.modelCalls).toBe(7)
    expect(w.acceptance.runs).toHaveLength(3)
    expect(w.acceptance.runs.map((r) => r.logicalStepId)).toEqual([
      "delegate:verify:1",
      "delegate:verify:2",
      "delegate:verify:3",
    ])
    // Each fix round continues from the failing state, under its own step ids.
    const [work, repair] = w.workspace.staged.map((entry) => entry.revision)
    expect(toolSteps(w)).toEqual([
      ["delegate:s1:work:1:turn:1", "rev-0"],
      ["delegate:fix1:repair:2:turn:1", work],
      ["delegate:fix2:takeover:3:turn:1", repair],
    ])
    expect(w.workspace.staged[2].patch.files[0].content).toBe("lead attempt\n")
    // The repair and the takeover see the objective failure report.
    const repairPrompt = w.requests[3].messages.map((m) => m.content).join("\n")
    expect(repairPrompt).toContain("expected 2 rows, got 3")
    const takeoverPrompt = w.requests[5].messages.map((m) => m.content).join("\n")
    expect(takeoverPrompt).toContain(
      "you are the lead, taking this work over after the worker's attempt failed"
    )
    expect(takeoverPrompt).toContain("expected 2 rows, got 3")
  })

  it("[ACC:DEL-06] stops after the first verification when the action allows no repair and no takeover", async () => {
    const w = world({ lead: [plan()], worker: session() }, { acceptance: failing })
    const error = await failure(runDelegateWorkflow(w.ports, input({ limits: noEscalation })))
    expect(error.details).toMatchObject({ attempts: 1, repairs: 0, takeovers: 0, round: 1 })
    expect(w.requests.map((r) => r.role)).toEqual(["lead", "worker", "worker"])
    expect(w.acceptance.runs).toHaveLength(1)
  })

  it("[ACC:DEL-06] degrades only an inconclusive last verification, and only when the request allows it", async () => {
    const timeout: MemoryAcceptanceScript = () => ({
      kind: "execution",
      exitCode: null,
      timedOut: true,
      report: { format: "junit", content: null },
    })
    const w = world(
      {
        lead: [plan(), ...session("lead\n")],
        worker: [...session(), ...session("repair\n")],
      },
      { acceptance: timeout }
    )
    const outcome = completed(await runDelegateWorkflow(w.ports, input({ allowDegraded: true })))
    expect(w.acceptance.runs).toHaveLength(3)
    expect(outcome.takeovers).toBe(1)
    expect(outcome.result.quality_status).toBe("degraded")
    expect(outcome.result.delivery).toBe("patch_only")
    expect(outcome.result.warnings).toEqual(
      expect.arrayContaining([
        "repaired:1",
        "taken_over_by_lead",
        "verification_inconclusive:ACCEPTANCE_INCONCLUSIVE",
      ])
    )
    expect(w.events.some((e) => e.type === "run.degraded")).toBe(true)
  })

  // ── DEL-07 ──

  it("[ACC:DEL-06] ends on the last verification when a fix round produces nothing", async () => {
    const stuck = (n: number): Step[] =>
      Array.from({ length: n }, (_, i) => read(Object.keys(FILES)[i % 4]))
    const repairOnly = { ...noEscalation, workerRepairRounds: 1 }

    // The repair keeps asking for tools and never answers: nothing new is
    // staged, nothing is verified again, and the failed verification stands.
    const failed = world(
      { lead: [plan()], worker: [...session(), ...stuck(8)] },
      { acceptance: failing }
    )
    const error = await failure(runDelegateWorkflow(failed.ports, input({ limits: repairOnly })))
    expect(error.code).toBe("VERIFICATION_FAILED")
    expect(error.details).toMatchObject({
      round: 1,
      repairs: 1,
      takeovers: 0,
      last_outcome: "incomplete",
      last_reason: "WORKER_TURN_LIMIT",
    })
    expect(failed.acceptance.runs).toHaveLength(1)
    expect(failed.workspace.staged).toHaveLength(1)

    // The same run, inconclusive instead of failed and allowed to degrade,
    // delivers what the last verification saw.
    const unclear = world(
      { lead: [plan()], worker: [...session(), ...stuck(8)] },
      {
        acceptance: () => ({
          kind: "execution",
          exitCode: null,
          timedOut: true,
          report: { format: "junit", content: null },
        }),
      }
    )
    const outcome = completed(
      await runDelegateWorkflow(unclear.ports, input({ limits: repairOnly, allowDegraded: true }))
    )
    expect(outcome.result.quality_status).toBe("degraded")
    expect(outcome.verifications).toHaveLength(1)
    expect(outcome.attempts.map((a) => a.outcome)).toEqual(["staged", "incomplete"])
    expect(outcome.result.warnings).toContain("repaired:1")
  })

  it("parks a fix round that asks for a path outside every subtask's scope", async () => {
    const w = world(
      {
        lead: [plan()],
        worker: [
          ...session(),
          write("config/app.json", '{"pageSize": 50}\n'),
          done({ summary: "Raised the page size." }),
        ],
      },
      {
        acceptance: ({ run }) =>
          run === 0
            ? { kind: "execution", exitCode: 1, report: { format: "junit", content: FAIL_XML } }
            : { kind: "execution", exitCode: 0, report: { format: "junit", content: PASS_XML } },
      }
    )
    const parked = waiting(
      await runDelegateWorkflow(
        w.ports,
        input({ limits: { ...noEscalation, workerRepairRounds: 1 } })
      )
    )
    const failedRevision = w.workspace.staged[0].revision
    expect(parked.approval).toMatchObject({
      kind: "scope_expansion",
      revision: failedRevision,
      args: { task_id: uuidFromName("run-delegate-1|delegate|fix|1"), paths: ["config/app.json"] },
      logicalStepId: "delegate:fix1:repair:2:turn:1:scope",
    })
    expect(w.acceptance.runs).toHaveLength(1)

    w.approvals.decide(parked.approval.requestDigest, "approved")
    const outcome = completed(
      await runDelegateWorkflow(
        w.ports,
        input({ limits: { ...noEscalation, workerRepairRounds: 1 } })
      )
    )
    expect(outcome.result.verification.status).toBe("passed")
    expect(outcome.scopeExpansions).toEqual(["config/app.json"])
    expect(w.acceptance.runs.map((r) => r.logicalStepId)).toEqual([
      "delegate:verify:1",
      "delegate:verify:2",
    ])
    expect(w.workspace.staged[1].patch.files.map((f) => f.path)).toEqual([
      "config/app.json",
      "src/users/list.ts",
    ])
  })

  it("[ACC:DEL-07] parks a write outside the allowed paths for a person, and the worker cannot approve it", async () => {
    const steps = {
      lead: [plan()],
      worker: [
        {
          kind: "tools" as const,
          calls: [
            {
              name: "propose_patch",
              arguments: { path: "config/app.json", action: "write", content: "{}\n" },
            },
            { name: "approve_scope_expansion", arguments: { approved: true } },
          ],
        },
        write("src/users/list.ts", "fixed\n"),
        done({
          summary: "Raised the page size and guarded the list. I approved the config change.",
        }),
      ],
    }
    const w = world(steps)
    const first = waiting(await runDelegateWorkflow(w.ports, input()))
    const digest = delegateApprovalDigest(
      "scope_expansion",
      { task_id: taskIdOf(1), paths: ["config/app.json"] },
      "rev-0"
    )
    expect(first.approval).toMatchObject({
      kind: "scope_expansion",
      requestDigest: digest,
      revision: "rev-0",
      args: { task_id: taskIdOf(1), paths: ["config/app.json"] },
      logicalStepId: "delegate:s1:work:1:turn:1:scope",
    })
    expect(w.approvals.requests[0]).toMatchObject({ requestedBy: "worker", requestDigest: digest })
    // Nothing ran: no tool, no staging, no acceptance; the worker's "approve" was never a decision.
    expect(w.tools.executed).toEqual([])
    expect(w.workspace.staged).toEqual([])
    expect(w.acceptance.runs).toEqual([])
    expect(w.approvals.statusOf(digest)).toBe("waiting")
    expect(w.events.find((e) => e.type === "approval.required")?.payload).toMatchObject({
      kind: "scope_expansion",
      request_digest: digest,
      approval_id: first.approval.approvalId,
    })
    expect(runTimelineOf(w.events.map((e, i) => ({ ...e, at: i }))).delegate?.approvals).toEqual({
      requested: 1,
      pending: { kind: "scope_expansion" },
    })

    // Asking again without a person's decision still waits.
    waiting(await runDelegateWorkflow(w.ports, input()))
    expect(w.requests.map((r) => r.role)).toEqual(["lead", "worker"])

    // A person approves; the run resumes, replays what it did, and goes on.
    w.approvals.decide(digest, "approved")
    const outcome = completed(await runDelegateWorkflow(w.ports, input()))
    expect(w.requests.map((r) => r.role)).toEqual(["lead", "worker", "worker", "worker"])
    const executed = w.tools.executed.map((e) => [
      e.intent.name,
      e.receipt.status,
      e.receipt.refusalCode ?? null,
    ])
    expect(executed).toEqual([
      ["propose_patch", "succeeded", null],
      ["propose_patch", "succeeded", null],
    ])
    expect(outcome.scopeExpansions).toEqual(["config/app.json"])
    expect(outcome.result.warnings).toContain("scope_expanded_with_approval")
    const staged = w.workspace.staged[0].patch.files.map((f) => f.path)
    expect(staged).toEqual(["config/app.json", "src/users/list.ts"])
    const turnTwo = w.requests[2].messages.map((m) => m.content).join("\n")
    expect(turnTwo).toContain("approve_scope_expansion (")
    expect(turnTwo).toContain("TOOL_NOT_OFFERED")
    const timeline = runTimelineOf(w.events.map((e, i) => ({ ...e, at: i })))
    expect(timeline.delegate?.approvals).toEqual({ requested: 1, pending: null })
    expect(timeline.delegate?.workerTurns).toBe(3)
  })

  it("[ACC:DEL-07] binds a scope approval to the subtask that asked for it", async () => {
    const w = world({
      lead: [
        plan({
          subtasks: [
            draft(),
            draft({ goal: "second", allowed_paths: ["tests/users"], max_steps: 4 }),
          ],
        }),
      ],
      worker: [
        write("src/users/list.ts", "guarded\n"),
        done({ summary: "Guarded." }),
        write("config/app.json", "{}\n"),
        write("tests/users/list.test.ts", "t\n"),
        done({ summary: "Covered." }),
      ],
    })
    const parked = waiting(await runDelegateWorkflow(w.ports, input()))
    const first = w.workspace.staged[0].revision
    // The digest names subtask 2 and the revision subtask 2 started from.
    expect(parked.approval).toMatchObject({
      revision: first,
      args: { task_id: taskIdOf(2), paths: ["config/app.json"] },
      logicalStepId: "delegate:s2:work:2:turn:1:scope",
    })
    expect(parked.approval.requestDigest).toBe(
      delegateApprovalDigest(
        "scope_expansion",
        { task_id: taskIdOf(2), paths: ["config/app.json"] },
        first
      )
    )

    w.approvals.decide(parked.approval.requestDigest, "approved")
    const outcome = completed(await runDelegateWorkflow(w.ports, input()))
    // Subtask 1 replayed: no second model call for it, and no second staging.
    expect(w.requests.map((r) => r.role)).toEqual([
      "lead",
      "worker",
      "worker",
      "worker",
      "worker",
      "worker",
    ])
    expect(w.workspace.staged.map((s) => s.logicalStepId)).toEqual([
      "delegate:s1:stage:1",
      "delegate:s2:stage:2",
    ])
    expect(w.acceptance.runs).toHaveLength(1)
    expect(outcome.scopeExpansions).toEqual(["config/app.json"])
    expect(outcome.result.verification.status).toBe("passed")
  })

  it("[ACC:DEL-07] asks again, with a fresh digest, for a path no approval in this run covers", async () => {
    // A person approves config/app.json for subtask 1; a later fix round may
    // write it without asking again, but anything else is a new request.
    const approveSubtaskOne = (request: { args: Record<string, unknown> }) =>
      request.args.task_id === taskIdOf(1) ? ("approved" as const) : undefined
    const w = world(
      {
        lead: [plan()],
        worker: [
          write("config/app.json", '{"pageSize": 50}\n'),
          done({ summary: "Raised the page size." }),
          {
            kind: "tools",
            calls: [
              {
                name: "propose_patch",
                arguments: {
                  path: "config/app.json",
                  action: "write",
                  content: '{"pageSize": 25}\n',
                },
              },
              {
                name: "propose_patch",
                arguments: { path: "deploy/prod.yaml", action: "write", content: "replicas: 2\n" },
              },
              { name: "approve_scope_expansion", arguments: { approved: true } },
            ],
          },
          write("src/users/list.ts", "guarded\n"),
          done({ summary: "Tuned the page size and guarded the list." }),
        ],
      },
      {
        approvalPolicy: approveSubtaskOne,
        acceptance: ({ run }) =>
          run === 0
            ? { kind: "execution", exitCode: 1, report: { format: "junit", content: FAIL_XML } }
            : { kind: "execution", exitCode: 0, report: { format: "junit", content: PASS_XML } },
      }
    )
    const limits = { ...noEscalation, workerRepairRounds: 1 }
    const parked = waiting(await runDelegateWorkflow(w.ports, input({ limits })))

    const failedRevision = w.workspace.staged[0].revision
    const fixTaskId = uuidFromName("run-delegate-1|delegate|fix|1")
    const granted = delegateApprovalDigest(
      "scope_expansion",
      { task_id: taskIdOf(1), paths: ["config/app.json"] },
      "rev-0"
    )
    const fresh = delegateApprovalDigest(
      "scope_expansion",
      { task_id: fixTaskId, paths: ["deploy/prod.yaml"] },
      failedRevision
    )
    // Exactly two requests: the fix round inherited config/app.json and asked
    // only about the path no approval of this run covers.
    expect(w.approvals.requests.map((r) => [r.requestDigest, r.args])).toEqual([
      [granted, { task_id: taskIdOf(1), paths: ["config/app.json"] }],
      [fresh, { task_id: fixTaskId, paths: ["deploy/prod.yaml"] }],
    ])
    expect(fresh).not.toBe(granted)
    expect(parked.approval.requestDigest).toBe(fresh)
    expect(w.approvals.statusOf(granted)).toBe("approved")
    expect(w.approvals.statusOf(fresh)).toBe("waiting")
    // The worker's own "approve" call is not a decision, and nothing outside
    // the approved scope was written or staged for the fix round.
    expect(
      w.tools.executed
        .filter((e) => e.context.logicalStepId.startsWith("delegate:fix1:"))
        .map((e) => [e.intent.name, e.receipt.status, e.receipt.refusalCode ?? null])
    ).toEqual([])
    expect(w.workspace.staged).toHaveLength(1)
    expect(w.acceptance.runs).toHaveLength(1)

    // The granted approval does not cover the new path: the run stays parked
    // until the fresh digest itself is decided.
    waiting(await runDelegateWorkflow(w.ports, input({ limits })))
    expect(w.approvals.statusOf(fresh)).toBe("waiting")
    w.approvals.decide(fresh, "approved")
    const outcome = completed(await runDelegateWorkflow(w.ports, input({ limits })))
    expect(outcome.scopeExpansions).toEqual(["config/app.json", "deploy/prod.yaml"])
    expect(w.workspace.staged[1].patch.files.map((f) => f.path)).toEqual([
      "config/app.json",
      "deploy/prod.yaml",
      "src/users/list.ts",
    ])
    const fixTurn =
      w.requests
        .at(-2)
        ?.messages.map((m) => m.content)
        .join("\n") ?? ""
    expect(fixTurn).toContain("approve_scope_expansion (")
    expect(fixTurn).toContain("TOOL_NOT_OFFERED")
  })

  it("[ACC:DEL-07] does not let one subtask's approval authorize another subtask's write", async () => {
    const w = world(
      {
        lead: [
          plan({
            subtasks: [
              draft(),
              draft({ goal: "second", allowed_paths: ["tests/users"], max_steps: 4 }),
            ],
          }),
        ],
        worker: [
          write("config/app.json", '{"pageSize": 50}\n'),
          done({ summary: "Raised the page size." }),
          write("config/app.json", '{"pageSize": 10}\n'),
          write("tests/users/list.test.ts", "t\n"),
          done({ summary: "Covered it." }),
        ],
        // Only subtask 1 has a person's answer standing by.
      },
      { approvalPolicy: (r) => (r.args.task_id === taskIdOf(1) ? "approved" : undefined) }
    )
    const parked = waiting(await runDelegateWorkflow(w.ports, input()))

    const first = w.workspace.staged[0].revision
    const one = delegateApprovalDigest(
      "scope_expansion",
      { task_id: taskIdOf(1), paths: ["config/app.json"] },
      "rev-0"
    )
    const two = delegateApprovalDigest(
      "scope_expansion",
      { task_id: taskIdOf(2), paths: ["config/app.json"] },
      first
    )
    // The same path, a different subtask: a different digest, still waiting.
    expect(one).not.toBe(two)
    expect(parked.approval.requestDigest).toBe(two)
    expect(w.approvals.statusOf(one)).toBe("approved")
    expect(w.approvals.statusOf(two)).toBe("waiting")
    expect(w.approvals.requests.map((r) => r.args)).toEqual([
      { task_id: taskIdOf(1), paths: ["config/app.json"] },
      { task_id: taskIdOf(2), paths: ["config/app.json"] },
    ])
    // Subtask 2 wrote nothing while it waits.
    expect(w.workspace.staged).toHaveLength(1)
    expect(
      w.tools.executed.filter((e) => e.context.logicalStepId.startsWith("delegate:s2:"))
    ).toEqual([])

    w.approvals.decide(two, "approved")
    const outcome = completed(await runDelegateWorkflow(w.ports, input()))
    expect(outcome.scopeExpansions).toEqual(["config/app.json"])
    expect(w.workspace.staged[1].patch.files.map((f) => f.path)).toEqual([
      "config/app.json",
      "tests/users/list.test.ts",
    ])
  })

  it("[ACC:DEL-07] fails the step when a person denies the expansion", async () => {
    const w = world(
      { lead: [plan()], worker: [write("config/app.json", "{}\n"), done()] },
      { approvalPolicy: () => "denied" }
    )
    const error = await failure(runDelegateWorkflow(w.ports, input()))
    expect(error.code).toBe("SCOPE_EXPANSION_DENIED")
    expect(error.details).toMatchObject({ subtask: 1, paths: ["config/app.json"] })
    expect(w.tools.executed).toEqual([])
    expect(w.workspace.staged).toEqual([])
    expect(w.acceptance.runs).toEqual([])
    expect(w.requests.map((r) => r.role)).toEqual(["lead", "worker"])
  })

  it("[ACC:DEL-07] refuses an approval that answers a different digest", async () => {
    const forged: ApprovalPort = {
      async requestApproval() {
        return { status: "approved", approvalId: "a-1", requestDigest: "0".repeat(64) }
      },
    }
    const w = world(
      { lead: [plan()], worker: [write("config/app.json", "{}\n"), done()] },
      { approvals: forged }
    )
    const error = await failure(runDelegateWorkflow(w.ports, input()))
    expect(error.code).toBe("APPROVAL_MISMATCH")
    expect(w.tools.executed).toEqual([])
  })

  // ── limits and money ──

  it("holds tool operations and turns to their limits: refused past them, never run", async () => {
    const paths = Object.keys(FILES)
    const reads = (n: number) => ({
      kind: "tools" as const,
      calls: Array.from({ length: n }, (_, i) => ({
        name: "workspace_read",
        arguments: { path: paths[i % paths.length] },
      })),
    })
    const w = world({ lead: [plan()], worker: [reads(5), reads(2), done()] })
    const limits = { ...noEscalation, workerToolOperations: 3 }
    completed(await runDelegateWorkflow(w.ports, input({ limits })))
    expect(w.tools.executed).toHaveLength(3)
    const toolEvents = w.events.filter((e) => e.payload.step === "tools")
    expect(toolEvents[0].payload.admitted).toBe(3)
    expect(
      (toolEvents[0].payload.tools as Array<{ refusal?: string }>).map((t) => t.refusal ?? null)
    ).toEqual([null, null, null, "TOOL_OPERATION_LIMIT", "TOOL_OPERATION_LIMIT"])
    // Once the operations are spent, no tool is offered again.
    const workerCalls = w.requests.filter((r) => r.role === "worker")
    expect(workerCalls[0].tools?.map((t) => t.name)).toEqual([
      "workspace_read",
      "workspace_list",
      "propose_patch",
    ])
    expect(workerCalls[1].tools).toBeUndefined()
    expect(workerCalls[1].toolPolicyId).toBeNull()
    expect(
      (toolEvents[1].payload.tools as Array<{ refusal?: string }>).every(
        (t) => t.refusal === "NO_TOOLS_OFFERED"
      )
    ).toBe(true)
  })

  it("ends a session that never answers at its turn bound, offering no tools on the last turn", async () => {
    const w = world({
      lead: [plan({ subtasks: [draft({ max_steps: 3 })] })],
      worker: [read("README.md")],
    })
    const error = await failure(runDelegateWorkflow(w.ports, input({ limits: noEscalation })))
    expect(error.code).toBe("VERIFICATION_FAILED")
    expect(error.details).toMatchObject({
      subtask: 1,
      last_outcome: "incomplete",
      last_reason: "WORKER_TURN_LIMIT",
    })
    const workerCalls = w.requests.filter((r) => r.role === "worker")
    expect(workerCalls).toHaveLength(3)
    expect(workerCalls[2].tools).toBeUndefined()
    expect(w.workspace.staged).toEqual([])
    expect(w.acceptance.runs).toEqual([])
  })

  it("clamps an action's limits to the V1 ceilings", async () => {
    const reads = {
      kind: "tools" as const,
      calls: Array.from({ length: 14 }, (_, i) => ({
        name: "workspace_list",
        arguments: { prefix: `src/part-${i}` },
      })),
    }
    const w = world({
      lead: [plan({ subtasks: [draft({ max_steps: 20 })] })],
      worker: [reads, done()],
    })
    const outcome = completed(
      await runDelegateWorkflow(
        w.ports,
        input({
          limits: {
            maxSubtasks: 50,
            workerModelTurns: 50,
            workerToolOperations: 50,
            workerRepairRounds: 5,
            leadTakeovers: 5,
            maxFormatRepairs: 1,
            transportAttempts: 2,
          },
        })
      )
    )
    expect(outcome.subtasks[0].max_steps).toBe(8)
    expect(w.tools.executed).toHaveLength(12)
    await expect(
      runDelegateWorkflow(w.ports, input({ limits: { ...noEscalation, workerModelTurns: 0 } }))
    ).rejects.toMatchObject({ code: "LIMITS_INVALID" })
  })

  it("stops at the run's model-call limit through the ledger", async () => {
    const w = world({ lead: [plan()], worker: session() }, { maxModelCalls: 2 })
    const error = await failure(runDelegateWorkflow(w.ports, input()))
    expect(error).toBeInstanceOf(BudgetRefusedError)
    expect(error.code).toBe("MAX_MODEL_CALLS")
    expect(w.requests).toHaveLength(2)
  })

  it("refuses before any call when the plan and first worker turn cannot be reserved", async () => {
    const w = world({ lead: [plan()], worker: session() }, { cap: 4_000 })
    const error = await failure(runDelegateWorkflow(w.ports, input()))
    expect(error).toBeInstanceOf(BudgetRefusedError)
    expect(w.requests).toEqual([])
  })

  // ── plan review ──

  it("ends explicitly when the lead needs input, and refuses a plan that escapes the workspace", async () => {
    const needs = world({ lead: [plan({ status: "need_input", questions: ["Which list?"] })] })
    const asked = await failure(runDelegateWorkflow(needs.ports, input()))
    expect(asked.code).toBe("DELEGATE_NEEDS_INPUT")
    expect(asked.details).toEqual({ questions: ["Which list?"] })

    const blocked = world({ lead: [plan({ status: "blocked", questions: [] })] })
    expect((await failure(runDelegateWorkflow(blocked.ports, input()))).code).toBe(
      "DELEGATE_BLOCKED"
    )

    for (const path of ["../secrets", "/etc", ".", "src/.git/hooks"]) {
      const bad = world({ lead: [plan({ subtasks: [draft({ allowed_paths: [path] })] })] })
      const error = await failure(runDelegateWorkflow(bad.ports, input()))
      expect(error.code).toBe("PLAN_INVALID")
      expect(error.details).toMatchObject({ subtask: 1, path })
      expect(bad.requests.filter((r) => r.role === "worker")).toEqual([])
    }

    const invalid = world({ lead: [{ kind: "invalid_json" }] })
    const garbled = await failure(runDelegateWorkflow(invalid.ports, input()))
    expect(garbled.code).toBe("PLAN_INVALID")
    // One run-wide format repair, then refusal.
    expect(invalid.requests.map((r) => r.logicalStepId)).toEqual([
      "delegate:plan",
      "delegate:plan:format_repair",
    ])
  })

  it("holds the plan to between one and four subtasks", async () => {
    const empty = world({ lead: [plan({ subtasks: [] })] })
    expect((await failure(runDelegateWorkflow(empty.ports, input()))).code).toBe("PLAN_INVALID")

    const many = world({
      lead: [plan({ subtasks: Array.from({ length: 5 }, (_, i) => draft({ goal: `step ${i}` })) })],
    })
    const error = await failure(runDelegateWorkflow(many.ports, input()))
    expect(error).toMatchObject({
      code: "PLAN_INVALID",
      details: { subtasks: 5, max_subtasks: 4 },
    })
    expect(many.requests.filter((r) => r.role === "worker")).toEqual([])

    // Four is the ceiling, and a plan of four is planned in order.
    const four = world({
      lead: [
        plan({
          subtasks: Array.from({ length: 4 }, (_, i) =>
            draft({ goal: `step ${i + 1}`, max_steps: 2 })
          ),
        }),
      ],
      worker: [
        write("src/users/a.ts", "a\n"),
        done({ summary: "a" }),
        write("src/users/b.ts", "b\n"),
        done({ summary: "b" }),
        write("src/users/c.ts", "c\n"),
        done({ summary: "c" }),
        write("src/users/d.ts", "d\n"),
        done({ summary: "d" }),
      ],
    })
    const outcome = completed(await runDelegateWorkflow(four.ports, input()))
    expect(outcome.subtasks.map((s) => s.goal)).toEqual(["step 1", "step 2", "step 3", "step 4"])
    expect(outcome.turns).toBe(8)
    expect(four.acceptance.runs).toHaveLength(1)
    expect(outcome.result.answer).toBe("a\n\nb\n\nc\n\nd")
  })

  it("refuses to start when the tool policy cannot propose a patch, and offers only delegate tools", async () => {
    const noWrite = world({ lead: [plan()] }, { tools: { omit: ["propose_patch"] } })
    expect((await failure(runDelegateWorkflow(noWrite.ports, input()))).code).toBe(
      "DELEGATE_TOOLS_UNAVAILABLE"
    )
    expect(noWrite.requests).toEqual([])

    const extra = world(
      { lead: [plan()], worker: session() },
      {
        tools: {
          extra: [
            {
              name: "shell",
              description: "run anything",
              parameters: {},
              toolClass: "external_write",
            },
          ],
        },
      }
    )
    completed(await runDelegateWorkflow(extra.ports, input()))
    const offered = extra.requests.find((r) => r.role === "worker")?.tools?.map((t) => t.name)
    expect(offered).toEqual(["workspace_read", "workspace_list", "propose_patch"])
  })

  // ── delivery ──

  it("applies to the workspace only after a person approves exactly this patch", async () => {
    const w = world({ lead: [plan()], worker: session() })
    const parked = waiting(
      await runDelegateWorkflow(w.ports, input({ delivery: "workspace_updated" }))
    )
    expect(parked.approval.kind).toBe("workspace_apply")
    expect(parked.approval.summary.paths).toEqual(["src/users/list.ts"])
    expect(parked.approval.requestDigest).toBe(
      delegateApprovalDigest(
        "workspace_apply",
        { patch_sha256: parked.approval.summary.patchSha256, paths: ["src/users/list.ts"] },
        "rev-0"
      )
    )
    expect(w.workspace.applied).toEqual([])

    w.approvals.decide(parked.approval.requestDigest, "approved")
    const outcome = completed(
      await runDelegateWorkflow(w.ports, input({ delivery: "workspace_updated" }))
    )
    expect(outcome.result.delivery).toBe("workspace_updated")
    expect(outcome.deliveredRevision).toBe("rev-applied-1")
    expect(w.workspace.current).toBe("rev-applied-1")
    expect(w.workspace.applied[0]).toMatchObject({
      baseRevision: "rev-0",
      approvalId: parked.approval.approvalId,
    })
    // The replay after the approval neither re-staged, re-verified nor re-called a model.
    expect(w.acceptance.runs).toHaveLength(1)
    expect(w.workspace.staged).toHaveLength(1)
    expect(w.requests).toHaveLength(3)
  })

  it("delivers patch_only when the apply is declined, and never overwrites a workspace that moved", async () => {
    const declined = world(
      { lead: [plan()], worker: session() },
      { approvalPolicy: () => "denied" }
    )
    const kept = completed(
      await runDelegateWorkflow(declined.ports, input({ delivery: "workspace_updated" }))
    )
    expect(kept.result.delivery).toBe("patch_only")
    expect(kept.result.warnings).toContain("workspace_apply_declined")
    expect(declined.workspace.applied).toEqual([])

    const moved = world({ lead: [plan()], worker: session() })
    const parked = waiting(
      await runDelegateWorkflow(moved.ports, input({ delivery: "workspace_updated" }))
    )
    moved.workspace.externalEdit("src/users/list.ts", "someone else's fix\n")
    moved.approvals.decide(parked.approval.requestDigest, "approved")
    const error = await failure(
      runDelegateWorkflow(moved.ports, input({ delivery: "workspace_updated" }))
    )
    expect(error.code).toBe("PATCH_CONFLICT")
    expect(error.details).toMatchObject({ base_revision: "rev-0", current_revision: "rev-edit-1" })
    expect(moved.workspace.filesAt(moved.workspace.current)?.["src/users/list.ts"]).toBe(
      "someone else's fix\n"
    )
    expect(moved.workspace.applied).toEqual([])
  })

  it("does not ask to apply a degraded result", async () => {
    const w = world(
      { lead: [plan()], worker: session() },
      {
        acceptance: () => ({
          kind: "execution",
          exitCode: 0,
          report: { format: "junit", content: PASS_XML, truncated: true },
        }),
      }
    )
    const outcome = completed(
      await runDelegateWorkflow(
        w.ports,
        input({ limits: noEscalation, allowDegraded: true, delivery: "workspace_updated" })
      )
    )
    expect(outcome.result.delivery).toBe("patch_only")
    expect(outcome.result.warnings).toContain("workspace_apply_skipped_unverified")
    expect(w.approvals.requests).toEqual([])
  })

  // ── durability ──

  it("never re-runs an acceptance run that was dispatched and never answered", async () => {
    const w = world(
      { lead: [plan()], worker: session() },
      { acceptance: () => ({ kind: "throw", message: "sandbox vanished" }) }
    )
    const first = await failure(runDelegateWorkflow(w.ports, input()))
    expect(first.code).toBe("SIDE_EFFECT_OUTCOME_UNKNOWN")
    expect(first.details).toMatchObject({
      logical_step_id: "delegate:verify:1",
      side_effect: "acceptance_run",
    })
    const again = await failure(runDelegateWorkflow(w.ports, input()))
    expect(again.code).toBe("SIDE_EFFECT_OUTCOME_UNKNOWN")
    expect(w.acceptance.runs).toHaveLength(1)
  })

  it("fails explicitly, with no repair, when the runtime cannot run the profile", async () => {
    const w = world(
      { lead: [plan()], worker: session() },
      { acceptance: () => ({ kind: "refused", code: "SANDBOX_UNAVAILABLE" }) }
    )
    const error = await failure(runDelegateWorkflow(w.ports, input()))
    expect(error.code).toBe("SANDBOX_UNAVAILABLE")
    expect(w.requests.map((r) => r.role)).toEqual(["lead", "worker", "worker"])
  })

  it("replays a tool turn from the journal, and says so when its requests were lost", async () => {
    // The ledger replays committed tool calls; the journal is the second copy,
    // for a ledger that keeps only the text of a committed call.
    const w = world({
      lead: [plan()],
      worker: [write("config/app.json", "{}\n"), write("src/users/list.ts", "ok\n"), done()],
    })
    const parked = waiting(await runDelegateWorkflow(w.ports, input()))
    w.approvals.decide(parked.approval.requestDigest, "approved")
    // A crash between the call's commit and the journal record, on a ledger
    // that kept no tool calls: the turn replays without its requests.
    expect(w.journal.entries.get("delegate:s1:work:1:turn:1:intents")?.state).toBe("committed")
    w.journal.entries.delete("delegate:s1:work:1:turn:1:intents")
    const committed = w.ledger.attempts.find((a) => a.logicalStepId === "delegate:s1:work:1:turn:1")
    committed!.result = {
      text: committed!.result!.text,
      providerRequestId: committed!.result!.providerRequestId,
      finishReason: "tool_calls",
    }
    const outcome = completed(await runDelegateWorkflow(w.ports, input()))
    const turnTwo = w.requests[2].messages.map((m) => m.content).join("\n")
    expect(turnTwo).toContain("could not recover the tool requests")
    expect(outcome.scopeExpansions).toEqual([])
    expect(w.workspace.staged[0].patch.files.map((f) => f.path)).toEqual(["src/users/list.ts"])
  })

  it("refuses to replay a step recorded with another request, and re-stages an unanswered staging", async () => {
    const mismatch = world({ lead: [plan()], worker: session() })
    mismatch.journal.strand("delegate:base_revision", "base_revision", "somebody-else")
    expect((await failure(runDelegateWorkflow(mismatch.ports, input()))).code).toBe(
      "STEP_REPLAY_MISMATCH"
    )

    // A staging dispatched and never answered is idempotent: it is dispatched again.
    const restage = world({ lead: [plan()], worker: session() })
    const stage = restage.workspace.stagePatch.bind(restage.workspace)
    let crashes = 1
    restage.workspace.stagePatch = async (args) => {
      if (crashes-- > 0) throw new Error("worker process died")
      return stage(args)
    }
    await expect(runDelegateWorkflow(restage.ports, input())).rejects.toThrow("worker process died")
    expect(restage.journal.entries.get("delegate:s1:stage:1")?.state).toBe("dispatched")
    completed(await runDelegateWorkflow(restage.ports, input()))
    expect(restage.workspace.staged).toHaveLength(1)
    expect(restage.acceptance.runs).toHaveLength(1)
  })

  // ── sessions that produce nothing ──

  it("refuses malformed, escaping and oversized proposals before the runtime sees them", async () => {
    const big = "x".repeat(256 * 1024 + 1)
    const w = world({
      lead: [plan()],
      worker: [
        {
          kind: "tools",
          calls: [
            { name: "propose_patch", arguments: { path: "src/users/a.ts", action: "chmod" } },
            {
              name: "propose_patch",
              arguments: { path: "src/users/../../etc/passwd", action: "delete" },
            },
            {
              name: "propose_patch",
              arguments: { path: "src/.git/config", action: "write", content: "x" },
            },
            {
              name: "propose_patch",
              arguments: { path: "src/users/big.ts", action: "write", content: big },
            },
            { name: "propose_patch", arguments: { path: "src/users/old.ts", action: "delete" } },
          ],
        },
        done(),
      ],
    })
    const outcome = completed(await runDelegateWorkflow(w.ports, input()))
    const tools = w.events.find((e) => e.payload.step === "tools")?.payload.tools as Array<{
      refusal?: string
    }>
    expect(tools.map((t) => t.refusal ?? null)).toEqual([
      "INVALID_ARGUMENTS",
      "PATH_TRAVERSAL",
      "PATH_SENSITIVE",
      "PATCH_TOO_LARGE",
      null,
    ])
    expect(w.tools.executed.map((e) => e.intent.arguments.path)).toEqual(["src/users/old.ts"])
    expect(w.workspace.staged[0].patch.files).toEqual([
      { path: "src/users/old.ts", action: "delete", content: null, content_sha256: null },
    ])
    expect(outcome.result.delivery).toBe("patch_only")
  })

  it("repairs a result that is not JSON once, then gives up on the session", async () => {
    const repaired = world({
      lead: [plan()],
      worker: [write("src/users/list.ts", "y\n"), { kind: "invalid_json" }, done()],
    })
    const ok = completed(await runDelegateWorkflow(repaired.ports, input()))
    expect(ok.formatRepairs).toBe(1)
    expect(ok.result.warnings).toContain("format_repaired")

    const hopeless = world({
      lead: [plan()],
      worker: [write("src/users/list.ts", "y\n"), { kind: "invalid_json" }],
    })
    const error = await failure(
      runDelegateWorkflow(hopeless.ports, input({ limits: noEscalation }))
    )
    expect(error.details).toMatchObject({
      last_outcome: "incomplete",
      last_reason: "WORKER_OUTPUT_INVALID",
    })
    expect(hopeless.requests.filter((r) => r.role === "worker")).toHaveLength(3)
  })

  it("hands a blocked worker's report to the lead's takeover", async () => {
    const w = world({
      lead: [plan(), ...session("lead fix\n")],
      worker: [
        done({
          status: "blocked",
          summary: "The list module is generated.",
          open_questions: ["Edit the generator?"],
        }),
      ],
    })
    const outcome = completed(
      await runDelegateWorkflow(w.ports, input({ limits: { ...noEscalation, leadTakeovers: 1 } }))
    )
    expect(outcome.attempts.map((a) => [a.kind, a.outcome, a.reason])).toEqual([
      ["work", "blocked", "WORKER_BLOCKED"],
      ["takeover", "staged", null],
    ])
    const takeover = w.requests[2].messages.map((m) => m.content).join("\n")
    expect(takeover).toContain("open question: Edit the generator?")
    expect(takeover).toContain("you are the lead and do this work yourself")
    expect(outcome.result.warnings).toContain("taken_over_by_lead")
  })

  it("carries a repair past a path the runtime refused to stage", async () => {
    const workspace = new MemoryWorkspace(FILES)
    const stage = workspace.stagePatch.bind(workspace)
    let calls = 0
    workspace.stagePatch = async (args) => {
      calls++
      if (calls === 1)
        return {
          ok: false,
          code: "PATCH_REFUSED",
          message: "refused: PATH_ESCAPE",
          path: "tests/users/link.ts",
        }
      return stage(args)
    }
    const w = world(
      {
        lead: [plan()],
        worker: [
          write("tests/users/link.ts", "x\n"),
          write("src/users/list.ts", "fixed\n"),
          done(),
          done({ summary: "Dropped the linked file." }),
        ],
      },
      { workspace }
    )
    const outcome = completed(
      await runDelegateWorkflow(
        w.ports,
        input({ limits: { ...noEscalation, workerRepairRounds: 1 } })
      )
    )
    expect(outcome.attempts.map((a) => [a.outcome, a.reason])).toEqual([
      ["patch_refused", "PATCH_REFUSED"],
      ["staged", null],
    ])
    expect(w.workspace.staged[0].patch.files.map((f) => f.path)).toEqual(["src/users/list.ts"])
  })

  it("starts a repair from the chain's start when a staging refusal names no path", async () => {
    const workspace = new MemoryWorkspace(FILES)
    const stage = workspace.stagePatch.bind(workspace)
    let first = true
    workspace.stagePatch = async (args) => {
      if (first) {
        first = false
        return { ok: false, code: "PATCH_REFUSED", message: "quota", path: null }
      }
      return stage(args)
    }
    const w = world(
      {
        lead: [plan()],
        worker: [
          write("src/users/list.ts", "a\n"),
          done(),
          write("tests/users/x.ts", "b\n"),
          done(),
        ],
      },
      { workspace }
    )
    completed(
      await runDelegateWorkflow(
        w.ports,
        input({ limits: { ...noEscalation, workerRepairRounds: 1 } })
      )
    )
    expect(w.workspace.staged[0].patch.files.map((f) => f.path)).toEqual(["tests/users/x.ts"])
    expect(w.requests[3].messages.map((m) => m.content).join("\n")).toContain(
      "Files already in the patch: (none)"
    )
  })

  it("plans from a listing it could not read, and refuses a plan without a goal", async () => {
    const workspace = new MemoryWorkspace(FILES)
    workspace.listFiles = async () => ({ ok: false, code: "READ_FAILED", message: "io" })
    const unlisted = world({ lead: [plan()], worker: session() }, { workspace })
    completed(await runDelegateWorkflow(unlisted.ports, input()))
    expect(unlisted.requests[0].messages.map((m) => m.content).join("\n")).toContain(
      "(the workspace listing is unavailable: READ_FAILED)"
    )

    const noGoal = world({ lead: [plan({ subtasks: [draft({ goal: "  " })] })] })
    expect((await failure(runDelegateWorkflow(noGoal.ports, input()))).code).toBe("PLAN_INVALID")
    const sprawling = world({
      lead: [
        plan({
          subtasks: [draft({ allowed_paths: Array.from({ length: 33 }, (_, i) => `src/p${i}`) })],
        }),
      ],
    })
    const error = await failure(runDelegateWorkflow(sprawling.ports, input()))
    expect(error).toMatchObject({ code: "PLAN_INVALID", details: { allowed_paths: 33 } })
    const nothing = world({ lead: [plan({ subtasks: [draft({ allowed_paths: [] })] })] })
    expect((await failure(runDelegateWorkflow(nothing.ports, input()))).code).toBe("PLAN_INVALID")
  })

  // ── review and context ──

  it("compacts a long session through the compactor role and keeps the runtime's state", async () => {
    const big = "x".repeat(24_000)
    const workspace = new MemoryWorkspace({ ...FILES, "src/users/big.ts": big })
    const w = world(
      {
        lead: [plan()],
        worker: [read("src/users/big.ts"), ...session()],
        compactor: [{ kind: "text", text: "Read big.ts; nothing proposed yet." }],
      },
      { workspace }
    )
    completed(
      await runDelegateWorkflow(
        w.ports,
        input({ worker: { deploymentId: "fake-economy", contextLimit: 9_000 } })
      )
    )
    expect(w.requests.map((r) => r.role)).toEqual([
      "lead",
      "worker",
      "compactor",
      "worker",
      "worker",
    ])
    const after = w.requests[3].messages.map((m) => m.content).join("\n")
    expect(after).toContain("Authoritative task state")
    expect(after).toContain("write only inside: src/users, tests/users")
    expect(after).not.toContain(big)
  })

  it("reviews a verified change with the reviewer role and repairs on a failed review", async () => {
    const w = world({
      lead: [plan()],
      worker: [...session("first\n"), ...session("second\n")],
      reviewer: [
        { kind: "json", value: { status: "failed", issues: ["misses the empty page"] } },
        { kind: "json", value: { status: "passed", issues: [] } },
      ],
    })
    const outcome = completed(
      await runDelegateWorkflow(
        w.ports,
        input({ reviewer: { deploymentId: "fake-independent", contextLimit: 65_536 } })
      )
    )
    expect(w.requests.map((r) => r.role)).toEqual([
      "lead",
      "worker",
      "worker",
      "reviewer",
      "worker",
      "worker",
      "reviewer",
    ])
    expect(outcome.result.verification.level).toBe("mixed")
    expect(
      outcome.result.verification.checks.find((c) => c.check_id === "model_review")
    ).toMatchObject({ status: "passed", executed_by: "model" })
    expect(outcome.result.warnings).toContain("repaired:1")
    const repairPrompt = w.requests[4].messages.map((m) => m.content).join("\n")
    expect(repairPrompt).toContain("misses the empty page")
    const reviewPrompt = w.requests[3].messages.map((m) => m.content).join("\n")
    expect(reviewPrompt).toContain("--- before\nexport const list = []")
  })

  it("shows the reviewer new and deleted files, and treats an invalid review as inconclusive", async () => {
    const w = world({
      lead: [plan()],
      worker: [
        {
          kind: "tools",
          calls: [
            {
              name: "propose_patch",
              arguments: { path: "src/users/new.ts", action: "write", content: "n\n" },
            },
            { name: "propose_patch", arguments: { path: "src/users/list.ts", action: "delete" } },
          ],
        },
        done(),
      ],
      reviewer: [{ kind: "invalid_json" }, { kind: "invalid_json" }],
    })
    const outcome = completed(
      await runDelegateWorkflow(
        w.ports,
        input({
          reviewer: { deploymentId: "fake-independent", contextLimit: 65_536 },
          limits: noEscalation,
          allowDegraded: true,
        })
      )
    )
    const review = w.requests
      .find((r) => r.role === "reviewer")
      ?.messages.map((m) => m.content)
      .join("\n")
    expect(review).toContain(
      "### src/users/new.ts (write)\n--- before\n(the file does not exist at the base revision)"
    )
    expect(review).toContain("### src/users/list.ts (delete)")
    expect(review).toContain("+++ after\n(deleted)")
    expect(outcome.result.verification).toMatchObject({ status: "inconclusive", level: "mixed" })
    expect(
      outcome.result.verification.checks.find((c) => c.check_id === "model_review")?.summary
    ).toBe("the review output was not valid")
    expect(outcome.result.quality_status).toBe("degraded")
  })

  it("stops on cancellation and on the deadline before doing anything", async () => {
    const controller = new AbortController()
    controller.abort()
    const cancelled = world({ lead: [plan()] })
    expect(
      (await failure(runDelegateWorkflow(cancelled.ports, input({ signal: controller.signal }))))
        .code
    ).toBe("CANCELLED")
    const late = world({ lead: [plan()] })
    expect((await failure(runDelegateWorkflow(late.ports, input({ deadlineAt: 0 })))).code).toBe(
      "DEADLINE_EXCEEDED"
    )
    expect([...cancelled.requests, ...late.requests]).toEqual([])
  })
})
