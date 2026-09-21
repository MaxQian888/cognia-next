/** @jest-environment jsdom */
/**
 * A delegate run, end to end through `executeFusionRun` (ADR-0188 B4, WP-D4).
 *
 * The orchestrator, the real fusion database, the real ledger and the real
 * step journal; the device's four ports are the package's in-memory doubles,
 * because a sandbox and a checkout are not what this file is about. What it is
 * about is the wiring: that a delegate run routes, reserves, works, verifies,
 * parks on a person, resumes into the same graph, and seals exactly once.
 */
import "fake-indexeddb/auto"

import type { AppSettings } from "@cognia/agent-config-types"
import {
  DELEGATE_WORK_POLICY,
  FAKE_SEMANTICS,
  FakeProvider,
  MemoryAcceptancePort,
  MemoryDelegateToolRuntime,
  MemoryWorkspace,
  delegateApprovalDigest,
  fakeCompiledConfig,
  fixtureRouteRequest,
  junitFixture,
  routeAction,
  uuidFromName,
  type AcceptancePort,
  type DelegateStepJournal,
  type DelegateToolRuntime,
  type FakeStep,
  type MemoryAcceptanceScript,
  type RoleCallExecutor,
  type RoleCallRequest,
  type ToolRuntime,
} from "@cognia/router-fusion"

import { fusionContentCodec } from "../db/content-codec"
import {
  createFusionDelegateStepStore,
  listRunApprovals,
  pendingApprovalOf,
} from "../db/delegate-store"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore, type CreateRunInput } from "../db/ledger-store"
import type { OutboxAppliers } from "../db/outbox"
import { encodeRunInput } from "../db/run-input"
import { decideFusionApproval } from "./delegate-approvals"
import { createDelegateStepJournal } from "./delegate-step-journal"
import type { DelegateHostPorts } from "./delegate-host-ports"
import { executeFusionRun, delegateRunContext } from "./orchestrator-host"

const USD = 1_000_000
const config = fakeCompiledConfig()
let dbCounter = 0

const appliers: OutboxAppliers = {
  usage_row: jest.fn(async () => "applied" as const),
  execution_run_milestone: jest.fn(async () => "applied" as const),
  execution_run_projection: jest.fn(async () => "applied" as const),
  session_message: jest.fn(async () => "applied" as const),
}

beforeEach(() => {
  for (const applier of Object.values(appliers)) (applier as jest.Mock).mockClear()
})

// ── the scripted provider ─────────────────────────────────────────────────────

type Step = FakeStep

function scripted(steps: Record<string, Step[]>) {
  const seen: Record<string, number> = {}
  let current: Step = { kind: "text", text: "" }
  const fake = new FakeProvider(() => current)
  const requests: RoleCallRequest[] = []
  const executor: RoleCallExecutor = {
    async call(request, signal) {
      requests.push(request)
      const list = steps[request.role] ?? [{ kind: "text", text: `unscripted ${request.role}` }]
      const index = seen[request.role] ?? 0
      seen[request.role] = index + 1
      current = list[Math.min(index, list.length - 1)] as Step
      return fake.call(request, signal)
    },
  }
  return { executor, requests }
}

const draft = (overrides: Record<string, unknown> = {}) => ({
  goal: "Fix the pagination race in the users list",
  allowed_paths: ["src/users"],
  constraints: [],
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

const write = (path: string, content = "export const list = guarded([])\n"): Step => ({
  kind: "tool_call",
  name: "propose_patch",
  arguments: { path, action: "write", content },
})

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

const FILES = {
  "src/users/list.ts": "export const list = []\n",
  "tests/users/list.test.ts": "test('race condition', () => {})\n",
}

// ── the world ─────────────────────────────────────────────────────────────────

const RUN_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
const PROJECT_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"

interface Harness {
  db: FusionDB
  store: FusionLedgerStore
  workspace: MemoryWorkspace
  acceptance: MemoryAcceptancePort
  journal: DelegateStepJournal
  journalStore: ReturnType<typeof createFusionDelegateStepStore>
  ports: DelegateHostPorts
  disposed: () => number
}

function harness(
  options: { acceptance?: MemoryAcceptanceScript; files?: Record<string, string> } = {}
): Harness {
  const name = `fusion-delegate-orchestrator-${++dbCounter}`
  const db = new FusionDB(name)
  const store = new FusionLedgerStore({ db, codec: fusionContentCodec(name) })
  let ids = 0
  const newId = () => `99999999-9999-4999-8999-${String(++ids).padStart(12, "0")}`
  const workspace = new MemoryWorkspace(options.files ?? FILES)
  const acceptance = new MemoryAcceptancePort(options.acceptance ?? passing, newId)
  const journalStore = createFusionDelegateStepStore(db, store.contentCodec)
  const journal = createDelegateStepJournal({ runId: RUN_ID, store: journalStore })
  const tools = new MemoryDelegateToolRuntime(workspace, store.artifactStore(RUN_ID))
  let disposals = 0
  const ports: DelegateHostPorts = {
    workspace: Object.assign(workspace, {
      staged: workspace.staged as never,
      rootForRevision: async (revision: string) => `/tmp/${revision}`,
      dispose: async () => {
        disposals += 1
      },
    }) as unknown as DelegateHostPorts["workspace"],
    acceptance: acceptance as AcceptancePort,
    tools: tools as unknown as ToolRuntime & DelegateToolRuntime,
    journal,
  }
  return {
    db,
    store,
    workspace,
    acceptance,
    journal,
    journalStore,
    ports,
    disposed: () => disposals,
  }
}

function runInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  const { decision } = routeAction(
    config,
    fixtureRouteRequest({ runId: RUN_ID, decisionId: `decision-${RUN_ID}` })
  )
  return {
    runId: RUN_ID,
    sessionId: null,
    surface: "gatewayRuns",
    origin: "gateway",
    decision,
    actionId: "delegate_code",
    ruleId: "delegate_multifile",
    roleDeployments: { lead: "fake-baseline", worker: "fake-economy" },
    config,
    capMicrousd: 5 * USD,
    maxModelCalls: 24,
    deadlineMs: 900_000,
    budgetMode: "tracked",
    tenantLimitRemainingMicrousd: null,
    projectId: PROJECT_ID,
    workspaceRoot: "/repo",
    acceptanceProfileId: "unit",
    task: "code.debug",
    acceptanceProfile: "code_fixture",
    driver: "orchestrator",
    ...overrides,
  }
}

async function createRun(h: Harness, overrides: Partial<CreateRunInput> = {}): Promise<void> {
  const created = await h.store.createRun(runInput(overrides))
  if (!created.ok) throw new Error(`could not create the run: ${created.code}`)
  const stored = await h.store.artifactStore(null).put(
    encodeRunInput({
      messages: [{ role: "user", content: "Fix the pagination race and keep the tests green." }],
      allowDegraded: false,
      jsonSchema: null,
    }),
    "application/json",
    `delegate-input/${RUN_ID}`
  )
  await h.db.fusionArtifacts.update(stored.artifactId, { runId: RUN_ID })
  await h.db.fusionRuns.update(RUN_ID, { inputArtifactId: stored.artifactId })
}

function deps(h: Harness, steps: Record<string, Step[]>, overrides: Record<string, unknown> = {}) {
  const { executor, requests } = scripted(steps)
  return {
    requests,
    deps: {
      store: async () => h.store,
      appliers,
      leaseOwner: "worker:delegate-test",
      appSettings: () => ({}) as AppSettings,
      executor,
      delegatePorts: async () => h.ports,
      sleep: async () => {},
      heartbeatMs: 1_000_000,
      cancelPollMs: 1_000_000,
      ...overrides,
    },
  }
}

const WORKING: Record<string, Step[]> = {
  lead: [plan()],
  worker: [write("src/users/list.ts"), done()],
}

// ── the happy path ────────────────────────────────────────────────────────────

describe("a delegate run through the orchestrator", () => {
  it("plans, works, verifies the staged revision and seals with the patch, leaving the workspace alone", async () => {
    const h = harness()
    await createRun(h)
    const { deps: d } = deps(h, WORKING)
    const outcome = await executeFusionRun(d, { runId: RUN_ID })

    expect(outcome.kind).toBe("succeeded")
    if (outcome.kind !== "succeeded") return
    expect(outcome.result.mode_executed).toBe("delegate")
    // Only the sandbox's own report can verify (DEL-01): the acceptance port
    // ran, on the revision the workspace staged.
    expect(h.acceptance.runs).toHaveLength(1)
    expect(h.acceptance.runs[0].revision).toBe(h.workspace.staged.at(-1)?.revision)
    // `patch_only`: the person's checkout never moved.
    expect(h.workspace.applied).toHaveLength(0)
    expect(h.workspace.current).toBe("rev-0")

    const run = await h.store.getRun(RUN_ID)
    expect(run?.status).toBe("succeeded")
    // The change is indexed for the review pane, against the base it applies to.
    const patchSets = await h.db.fusionPatchSets.where("runId").equals(RUN_ID).toArray()
    expect(patchSets).toHaveLength(1)
    expect(patchSets[0]).toMatchObject({
      baseRevision: "rev-0",
      paths: ["src/users/list.ts"],
      delivery: "patch_only",
      appliedRevision: null,
    })
    // Every non-model step went through the DURABLE journal, not a map.
    const steps = await h.journalStore.list(RUN_ID)
    expect(steps.map((step) => step.kind)).toEqual(
      expect.arrayContaining(["base_revision", "stage_patch", "acceptance_run"])
    )
    expect(steps.every((step) => step.state === "committed")).toBe(true)
    // The worktrees are given back exactly once, at the end.
    expect(h.disposed()).toBe(1)
  })

  it("spends its repair and its takeover once each, then fails — no loop (DEL-06)", async () => {
    const h = harness({ acceptance: failing })
    await createRun(h)
    const { deps: d } = deps(h, {
      lead: [plan(), done()],
      worker: [write("src/users/list.ts"), done(), write("src/users/list.ts", "v2\n"), done()],
    })
    const outcome = await executeFusionRun(d, { runId: RUN_ID })

    expect(outcome.kind).toBe("failed")
    if (outcome.kind !== "failed") return
    expect(outcome.code).toBe("VERIFICATION_FAILED")
    // One first pass, one repair, one takeover: three verified revisions, and
    // then it stops.
    expect(h.acceptance.runs).toHaveLength(3)
    const run = await h.store.getRun(RUN_ID)
    expect(run?.status).toBe("failed")
    expect(run?.error?.code).toBe("VERIFICATION_FAILED")
    expect(h.disposed()).toBe(1)
  })

  it("refuses a delegate run that carries no project, checkout or profile", async () => {
    const h = harness()
    await createRun(h, {
      projectId: undefined,
      workspaceRoot: undefined,
      acceptanceProfileId: undefined,
    })
    const { deps: d } = deps(h, WORKING)
    const outcome = await executeFusionRun(d, { runId: RUN_ID })

    expect(outcome).toMatchObject({ kind: "failed", code: "WORKSPACE_REQUIRED" })
    expect(h.acceptance.runs).toHaveLength(0)
    expect(() => delegateRunContext({ runId: RUN_ID } as never)).toThrow(
      /projectId, workspaceRoot, acceptanceProfileId/
    )
  })
})

// ── approvals (API-08) ────────────────────────────────────────────────────────

describe("[ACC:API-08] an approval is bound to the request it was asked for", () => {
  /** A worker that writes outside its subtask's allowed paths needs a person. */
  const OUT_OF_SCOPE: Record<string, Step[]> = {
    lead: [plan()],
    worker: [write("tests/users/list.test.ts", "test('race', () => {})\n"), done()],
  }

  async function park(h: Harness) {
    const { deps: d } = deps(h, OUT_OF_SCOPE)
    const outcome = await executeFusionRun(d, { runId: RUN_ID })
    expect(outcome.kind).toBe("waiting")
    return outcome
  }

  it("parks the run without sealing it and projects the decision as an interrupt", async () => {
    const h = harness()
    await createRun(h)
    const outcome = await park(h)
    if (outcome.kind !== "waiting") return

    const run = await h.store.getRun(RUN_ID)
    expect(run?.status).toBe("waiting_for_approval")
    expect(run?.terminalAt).toBeNull()
    expect(run?.pausedAt).toBeGreaterThan(0)
    // The money is still held: a parked run has not finished spending.
    expect(run?.budget.frozen).toBe(false)

    const pending = await pendingApprovalOf(h.db, RUN_ID)
    expect(pending).toMatchObject({
      status: "pending",
      kind: "scope_expansion",
      requestDigest: outcome.approval.requestDigest,
      projectId: PROJECT_ID,
    })
    // The approval's id IS the digest's id, so the interrupt names what is
    // being approved.
    expect(pending?.id).toBe(uuidFromName(`${RUN_ID} ${outcome.approval.requestDigest}`))
    const projection = (appliers.execution_run_projection as jest.Mock).mock.calls
      .map(([row]) => row as { payload: Record<string, unknown> })
      .find((row) => row.payload.phase === "waiting")
    expect(projection?.payload).toMatchObject({
      interrupt: expect.objectContaining({
        id: pending?.id,
        type: "fusion_approval",
        requestDigest: outcome.approval.requestDigest,
      }),
    })
    // The worktrees are NOT given back: the run still owns the change.
    expect(h.disposed()).toBe(0)
  })

  it("refuses a decision that names another digest, and leaves the request pending", async () => {
    const h = harness()
    await createRun(h)
    const outcome = await park(h)
    if (outcome.kind !== "waiting") return

    const otherDigest = delegateApprovalDigest(
      "scope_expansion",
      { paths: ["src/elsewhere"] },
      "rev-0"
    )
    const refused = await decideFusionApproval(h.store, {
      runId: RUN_ID,
      approvalId: uuidFromName(`${RUN_ID} ${otherDigest}`),
      decision: "approve",
    })
    expect(refused).toMatchObject({ ok: false, code: "APPROVAL_MISMATCH" })

    // Nothing was consumed: the standing request is still the one to answer.
    const pending = await pendingApprovalOf(h.db, RUN_ID)
    expect(pending?.status).toBe("pending")
    expect(pending?.requestDigest).toBe(outcome.approval.requestDigest)
    expect((await h.store.getRun(RUN_ID))?.status).toBe("waiting_for_approval")
    // And no approval row was invented for the digest nobody asked about.
    expect(await listRunApprovals(h.db, RUN_ID)).toHaveLength(1)
  })

  it("refuses a decision that names no approval at all", async () => {
    const h = harness()
    await createRun(h)
    await park(h)
    expect(
      await decideFusionApproval(h.store, { runId: RUN_ID, approvalId: null, decision: "approve" })
    ).toMatchObject({ ok: false, code: "APPROVAL_MISMATCH" })
    expect((await pendingApprovalOf(h.db, RUN_ID))?.status).toBe("pending")
  })

  it("refuses a decision that saw an older version of the run", async () => {
    const h = harness()
    await createRun(h)
    const outcome = await park(h)
    if (outcome.kind !== "waiting") return
    const pending = await pendingApprovalOf(h.db, RUN_ID)
    expect(
      await decideFusionApproval(h.store, {
        runId: RUN_ID,
        approvalId: pending?.id,
        decision: "approve",
        expectedVersion: 0,
      })
    ).toMatchObject({ ok: false, code: "RUN_VERSION_CONFLICT" })
    expect((await pendingApprovalOf(h.db, RUN_ID))?.status).toBe("pending")
  })

  it("resumes into the same graph when the right request is approved, and replays what it did", async () => {
    const h = harness()
    await createRun(h)
    const outcome = await park(h)
    if (outcome.kind !== "waiting") return
    const pending = await pendingApprovalOf(h.db, RUN_ID)
    const plannedBefore = h.workspace.staged.length

    const decided = await decideFusionApproval(h.store, {
      runId: RUN_ID,
      approvalId: pending?.id,
      decision: "approve",
    })
    expect(decided.ok).toBe(true)
    expect((await h.store.getRun(RUN_ID))?.status).toBe("queued")

    // The SAME input runs again; the committed steps replay from the journal.
    const { deps: d } = deps(h, OUT_OF_SCOPE)
    const resumed = await executeFusionRun(d, { runId: RUN_ID })
    expect(resumed.kind).toBe("succeeded")
    // The base revision was pinned once, not twice.
    const bases = (await h.journalStore.list(RUN_ID)).filter(
      (step) => step.kind === "base_revision"
    )
    expect(bases).toHaveLength(1)
    expect(h.workspace.staged.length).toBeGreaterThan(plannedBefore)
    expect(await pendingApprovalOf(h.db, RUN_ID)).toBeUndefined()
  })

  it("fails the run when the person says no", async () => {
    const h = harness()
    await createRun(h)
    const outcome = await park(h)
    if (outcome.kind !== "waiting") return
    const pending = await pendingApprovalOf(h.db, RUN_ID)
    expect(
      (
        await decideFusionApproval(h.store, {
          runId: RUN_ID,
          approvalId: pending?.id,
          decision: "deny",
        })
      ).ok
    ).toBe(true)

    const { deps: d } = deps(h, OUT_OF_SCOPE)
    const resumed = await executeFusionRun(d, { runId: RUN_ID })
    expect(resumed.kind).toBe("failed")
    if (resumed.kind !== "failed") return
    expect(resumed.code).toBe("SCOPE_EXPANSION_DENIED")
  })

  it("gives back the wall time a run spent parked, so a late approval still has a deadline", async () => {
    const h = harness()
    await createRun(h)
    const outcome = await park(h)
    if (outcome.kind !== "waiting") return
    const parkedRun = await h.store.getRun(RUN_ID)
    const deadlineWhenParked = parkedRun?.deadlineAt ?? 0
    const pausedAt = parkedRun?.pausedAt ?? 0

    // A person decides an hour later — longer than the run's own 900 s budget.
    const hourLater = pausedAt + 3_600_000
    const store = new FusionLedgerStore({
      db: h.db,
      codec: h.store.contentCodec,
      now: () => hourLater,
    })
    const pending = await pendingApprovalOf(h.db, RUN_ID)
    const decided = await decideFusionApproval(store, {
      runId: RUN_ID,
      approvalId: pending?.id,
      decision: "approve",
      now: () => hourLater,
    })
    expect(decided.ok).toBe(true)

    const resumed = await h.store.getRun(RUN_ID)
    expect(resumed?.status).toBe("queued")
    expect(resumed?.pausedAt ?? null).toBeNull()
    // Exactly the parked time, no more: the work budget is unchanged.
    expect(resumed?.deadlineAt).toBe(deadlineWhenParked + (hourLater - pausedAt))
    expect(resumed?.deadlineAt).toBeGreaterThan(hourLater)
  })
})

// ── recovery (REC-06) ─────────────────────────────────────────────────────────

describe("[ACC:REC-06] a dispatched side effect with no receipt is never re-run", () => {
  it("moves the run to reconciling with a handoff instead of sealing it or running the command again", async () => {
    const h = harness()
    await createRun(h)
    // A crash left the acceptance run dispatched and unanswered: the command
    // may have run, the tests may have changed the tree, and nothing on this
    // device can say. The step id is the one the graph will ask for.
    const { deps: d } = deps(h, WORKING)
    const first = await executeFusionRun(d, { runId: RUN_ID })
    expect(first.kind).toBe("succeeded")

    // Same graph, a second run whose acceptance step was left dispatched.
    const h2 = harness()
    await createRun(h2)
    const acceptanceStepId = (await (async () => {
      const { deps: probe } = deps(h2, WORKING)
      await executeFusionRun(probe, { runId: RUN_ID })
      const steps = await h2.journalStore.list(RUN_ID)
      return steps.find((step) => step.kind === "acceptance_run")?.stepId
    })()) as string
    expect(acceptanceStepId).toBeTruthy()

    const h3 = harness()
    await createRun(h3)
    const stranded = await h3.journalStore.get(RUN_ID, acceptanceStepId)
    expect(stranded).toBeUndefined()
    await h3.journalStore.put({
      runId: RUN_ID,
      stepId: acceptanceStepId,
      kind: "acceptance_run",
      // The request hash the graph will compute for this step.
      requestHash: (await (async () => {
        const steps = await h2.journalStore.list(RUN_ID)
        return steps.find((step) => step.stepId === acceptanceStepId)?.requestHash ?? ""
      })()) as string,
      state: "dispatched",
      receipt: null,
      encryptedReceipt: null,
      createdAt: 1,
      updatedAt: 1,
    })

    const { deps: d3 } = deps(h3, WORKING)
    const outcome = await executeFusionRun(d3, { runId: RUN_ID })

    expect(outcome).toMatchObject({ kind: "reconciling", code: "SIDE_EFFECT_OUTCOME_UNKNOWN" })
    const run = await h3.store.getRun(RUN_ID)
    // NOT sealed: reconciling keeps the money held and the trail intact.
    expect(run?.status).toBe("reconciling")
    expect(run?.terminalAt).toBeNull()
    // The command was never run a second time.
    expect(h3.acceptance.runs).toHaveLength(0)
    const handoff = (appliers.execution_run_projection as jest.Mock).mock.calls
      .map(([row]) => row as { payload: Record<string, unknown> })
      .find(
        (row) =>
          row.payload.phase === "waiting" &&
          (row.payload.interrupt as { type?: string } | undefined)?.type === "human_handoff"
      )
    expect(handoff).toBeTruthy()
    // The worktrees stay: a person may still need to look at what is on disk.
    expect(h3.disposed()).toBe(0)
  })
})

// ── the tool policy ───────────────────────────────────────────────────────────

describe("the delegate worker's tools", () => {
  it("are offered under the delegate policy and nothing else", async () => {
    const h = harness()
    await createRun(h)
    const { hostRunTools } = await import("./orchestrator-host")
    const action = config.actions.delegate_code
    const tools = await hostRunTools(
      h.store,
      (await h.store.getRun(RUN_ID))!,
      action,
      () => 0,
      h.ports
    )
    expect(tools.memberPolicyId).toBe(DELEGATE_WORK_POLICY)
    expect(tools.verificationPolicyId).toBeNull()
    expect(tools.runtime).toBe(h.ports.tools)
  })

  it("refuse to build without the run's workspace ports", async () => {
    const h = harness()
    await createRun(h)
    const action = config.actions.delegate_code
    await expect(
      (await import("./orchestrator-host")).hostRunTools(
        h.store,
        (await h.store.getRun(RUN_ID))!,
        action,
        () => 0
      )
    ).rejects.toMatchObject({ code: "DELEGATE_TOOLS_UNAVAILABLE" })
  })
})

// The semantics assertion the Fake Provider relies on, so a change to it
// surfaces here rather than as a mystery usage number.
it("bills delegate calls with the fake provider's usage semantics", () => {
  expect(FAKE_SEMANTICS.outputIncludesReasoning).toBe(true)
})
