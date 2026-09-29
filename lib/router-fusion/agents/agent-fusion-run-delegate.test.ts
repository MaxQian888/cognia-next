/** @jest-environment jsdom */
/**
 * An `agentsWorkflows` delegate run, end to end, across a person's approval
 * (ADR-0188 B4, D21).
 *
 * Nothing on the path under test is mocked: the real router
 * (`routeRunRequest`), the real fusion ledger, the real orchestrator and
 * delegate graph, the real account database with a real workflow execution
 * run, the real control plane (`executeRunControlCommand` with the installed
 * handlers) and the real `decideRouterFusionApproval`. The seams are the ones
 * a device supplies: a scripted `FakeProvider` for the models, the package's
 * in-memory doubles for the checkout, sandbox and tool runtime, and a routing
 * host whose aliases are fixed. What this file is about is the wiring: that a
 * workflow node's delegate run parks, that its question reaches the cockpit
 * on the workflow's own run, that the cockpit's answer resumes it, and that
 * the step that was waiting gets its answer.
 */
import "fake-indexeddb/auto"

import type { AppSettings } from "@cognia/agent-config-types"
import { RoutingNoCandidatesError } from "@cognia/provider-routing"
import type { RoutingPlan, RoutingRequest } from "@cognia/provider-types/auto-router"
import type { ModelPricing } from "@cognia/provider-types/provider"
import {
  FakeProvider,
  MemoryAcceptancePort,
  MemoryDelegateToolRuntime,
  MemoryWorkspace,
  junitFixture,
  uuidFromName,
  type AcceptancePort,
  type DelegateToolRuntime,
  type FakeStep,
  type MemoryAcceptanceScript,
  type RoleCallExecutor,
  type ToolRuntime,
} from "@cognia/router-fusion"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"

import { createExecutionRun, getExecutionRun } from "@/lib/db/execution-runs"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { installExecutionRunControlHandlers } from "@/lib/execution/control-handlers"
import { executeRunControlCommand } from "@/lib/execution/run-control"
import { workflowExecutionRunId } from "@/lib/execution/workflow-bridge"

import type { ChatRouteHost } from "../chat/route-chat-turn"
import { fusionContentCodec } from "../db/content-codec"
import { createFusionDelegateStepStore, pendingApprovalOf } from "../db/delegate-store"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import { drainFusionOutbox } from "../db/outbox"
import { accountDatabaseAppliers } from "../db/outbox-appliers"
import { decideRouterFusionApproval, projectedRunSurfaceOf } from "../gate/run-control"
import type { RouterFusionHost } from "../gate/load-engine"
import { createDelegateStepJournal } from "../runtime/delegate-step-journal"
import type { DelegateHostPorts } from "../runtime/delegate-host-ports"
import { driveRun } from "../runtime/run-driver"
import { runAgentsWorkflowsFusion, type AgentFusionRunDeps } from "./agent-fusion-run"

// ── the account and its routing ───────────────────────────────────────────────

const APP = {
  routerFusion: { enabled: true, surfaces: { agentsWorkflows: true } },
} as unknown as AppSettings

type Ref = { providerId: string; modelId: string }
const MINI: Ref = { providerId: "openai", modelId: "gpt-5-mini" }
const GPT: Ref = { providerId: "openai", modelId: "gpt-5" }
const SONNET: Ref = { providerId: "anthropic", modelId: "claude-sonnet-5" }
const PRICES: Record<string, Partial<ModelPricing>> = {
  "openai::gpt-5-mini": { promptPer1M: 0.1, completionPer1M: 0.4 },
  "openai::gpt-5": { promptPer1M: 1, completionPer1M: 2 },
  "anthropic::claude-sonnet-5": { promptPer1M: 3, completionPer1M: 15 },
}

let round = 0

function routeHost(): ChatRouteHost {
  let ids = 0
  const current = ++round
  const aliases: Record<string, Ref[]> = { fast: [MINI], powerful: [GPT], balanced: [SONNET] }
  return {
    settings: normalizeRouterFusionSettings({ enabled: true, surfaces: { agentsWorkflows: true } }),
    engineDeps: {
      getCapabilities: () => ({ tools: true, structuredOutput: true, vision: false }),
      getContextWindow: () => 200_000,
      isLocalProvider: () => false,
      getCircuitBreakerState: () => "closed",
      getDeploymentCircuitBreakerState: () => "closed",
      isProviderAvailable: () => true,
    },
    planRoute: async (request: RoutingRequest) => {
      const alias = request.selection.kind === "alias" ? request.selection.alias : ""
      const refs = aliases[alias]
      if (!refs?.length) throw new RoutingNoCandidatesError(`no ${alias}`)
      const candidates = refs.map((ref) => ({
        ...ref,
        deploymentId: `${ref.providerId}::${ref.modelId}`,
        reasonCodes: [],
      }))
      return {
        decisionId: "plan",
        surface: "gateway",
        requested: request.selection,
        strategy: "priority",
        selected: candidates[0],
        orderedCandidates: candidates,
        reasonCodes: [],
        rejected: [],
        replayPolicy: "pre-commit-only",
        createdAt: 0,
      } as unknown as RoutingPlan
    },
    pricingOf: (providerId, modelId) => PRICES[`${providerId}::${modelId}`] ?? null,
    subscriptionCapable: () => false,
    isAggregator: () => false,
    currentSettings: () => APP,
    environment: "test",
    now: () => Date.now(),
    newId: () => uuidFromName(`agent-delegate:${current}:${++ids}`),
  }
}

// ── the scripted models ───────────────────────────────────────────────────────

function scripted(steps: Record<string, FakeStep[]>): RoleCallExecutor {
  const seen: Record<string, number> = {}
  let current: FakeStep = { kind: "text", text: "" }
  const fake = new FakeProvider(() => current)
  return {
    async call(request, signal) {
      const list = steps[request.role] ?? [{ kind: "text", text: `unscripted ${request.role}` }]
      const index = seen[request.role] ?? 0
      seen[request.role] = index + 1
      current = list[Math.min(index, list.length - 1)] as FakeStep
      return fake.call(request, signal)
    },
  }
}

const plan: FakeStep = {
  kind: "json",
  value: {
    status: "ready",
    subtasks: [
      {
        goal: "Fix the pagination race in the users list",
        allowed_paths: ["src/users"],
        constraints: [],
        acceptance: ["the race-condition test passes"],
        max_steps: 6,
      },
    ],
    questions: [],
  },
}
const done: FakeStep = {
  kind: "json",
  value: {
    status: "completed",
    summary: "Guarded the list refresh with a request token.",
    claimed_check_ids: [],
    open_questions: [],
  },
}
const write = (path: string, content = "export const list = guarded([])\n"): FakeStep => ({
  kind: "tool_call",
  name: "propose_patch",
  arguments: { path, action: "write", content },
})

/** Writes inside its allowed paths: nothing to ask. */
const IN_SCOPE = { lead: [plan], worker: [write("src/users/list.ts"), done] }
/** Also writes a test outside `src/users`: a person must allow that path. */
const OUT_OF_SCOPE = {
  lead: [plan],
  worker: [write("tests/users/list.test.ts", "test('race', () => {})\n"), done],
}

const passing: MemoryAcceptanceScript = () => ({
  kind: "execution",
  exitCode: 0,
  report: {
    format: "junit",
    content: junitFixture([
      { name: "lists users", status: "passed" },
      { name: "race condition", status: "passed" },
    ]),
  },
})

const FILES = {
  "src/users/list.ts": "export const list = []\n",
  "tests/users/list.test.ts": "test('race condition', () => {})\n",
}

// ── the world ─────────────────────────────────────────────────────────────────

const PROJECT_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
const WORKFLOW_RUN = "wf-run-1"
const PARENT = workflowExecutionRunId(WORKFLOW_RUN)

interface World {
  store: FusionLedgerStore
  workspace: MemoryWorkspace
  acceptance: MemoryAcceptancePort
  deps: AgentFusionRunDeps
}

function world(steps: Record<string, FakeStep[]>): World {
  const name = `agent-fusion-delegate-${++round}`
  const db = new FusionDB(name)
  const store = new FusionLedgerStore({ db, codec: fusionContentCodec(name) })
  let ids = 0
  const newId = () => `99999999-9999-4999-8999-${String(++ids).padStart(12, "0")}`
  const workspace = new MemoryWorkspace(FILES)
  const acceptance = new MemoryAcceptancePort(passing, newId)
  const journalStore = createFusionDelegateStepStore(db, store.contentCodec)
  const ports = new Map<string, DelegateHostPorts>()
  const delegatePorts = async (_store: FusionLedgerStore, run: { runId: string }) => {
    // One set per run, reused across the park: a resumed run verifies the
    // very trees it staged before it asked.
    let existing = ports.get(run.runId)
    if (!existing) {
      existing = {
        workspace: Object.assign(workspace, {
          staged: workspace.staged as never,
          rootForRevision: async (revision: string) => `/tmp/${revision}`,
          dispose: async () => {},
        }) as unknown as DelegateHostPorts["workspace"],
        acceptance: acceptance as AcceptancePort,
        tools: new MemoryDelegateToolRuntime(
          workspace,
          store.artifactStore(run.runId)
        ) as unknown as ToolRuntime & DelegateToolRuntime,
        journal: createDelegateStepJournal({ runId: run.runId, store: journalStore }),
      }
      ports.set(run.runId, existing)
    }
    return existing
  }
  return {
    store,
    workspace,
    acceptance,
    deps: {
      store,
      routeHost: routeHost(),
      delegateCapabilities: {
        sandboxTier: async () => "os",
        acceptanceProfiles: async () => ({
          available: true,
          approvedProfileIds: ["unit"],
          reason: null,
        }),
      },
      executor: scripted(steps),
      delegatePorts: delegatePorts as AgentFusionRunDeps["delegatePorts"],
      leaseOwner: "window:delegate-integration",
      approvalPollMs: 5,
      orchestrator: { heartbeatMs: 1_000_000, cancelPollMs: 1_000_000 },
    },
  }
}

/** The host the gate loads: this test's store, the production driver. */
function hostFor(store: FusionLedgerStore): () => Promise<RouterFusionHost> {
  return async () =>
    ({
      currentFusionStore: async () => store,
      drainAccountOutbox: (s: FusionLedgerStore) =>
        drainFusionOutbox(s.db, accountDatabaseAppliers, s.outboxContext()),
      driveRun,
    }) as unknown as RouterFusionHost
}

/** The cockpit's control plane, with the fusion handler wired to this test's store. */
function installCockpit(store: FusionLedgerStore) {
  const loadHost = hostFor(store)
  return installExecutionRunControlHandlers({
    routerFusionRunSurface: (runId) => projectedRunSurfaceOf(runId, { settings: APP, loadHost }),
    decideRouterFusionApproval: (runId, decision, input) =>
      decideRouterFusionApproval(runId, decision, {
        settings: APP,
        surface: input.surface,
        ...(input.interruptId ? { interruptId: input.interruptId } : {}),
        loadHost,
      }),
  })
}

async function seedWorkflowRun(): Promise<void> {
  await createExecutionRun({
    id: PARENT,
    kind: "workflow",
    sourceId: WORKFLOW_RUN,
    title: "Nightly fixer",
    status: "running",
    initiator: { remoteUserId: "person-at-device" },
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
  })
}

async function waitFor<T>(read: () => Promise<T | undefined | null>): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting")
}

function delegateTurn(
  w: World,
  overrides: Partial<Parameters<typeof runAgentsWorkflowsFusion>[0]> = {}
) {
  return runAgentsWorkflowsFusion(
    {
      mode: "delegate",
      origin: "workflow",
      featureId: "workflow:fix-step",
      messages: [{ role: "user", content: "Fix the pagination race and keep the tests green." }],
      workspaceId: PROJECT_ID,
      workspaceRoot: "/repo",
      parentExecutionRunId: PARENT,
      hasFusionAncestor: false,
      appSettings: APP,
      ...overrides,
    },
    w.deps
  )
}

async function answer(
  action: "approve" | "deny",
  interruptId: string
): Promise<Awaited<ReturnType<typeof executeRunControlCommand>>> {
  const parent = await getExecutionRun(PARENT)
  return executeRunControlCommand({
    runId: PARENT,
    action,
    interruptId,
    idempotencyKey: `${action}:${interruptId}`,
    expectedRevision: parent!.currentRevision,
    actor: { remoteUserId: "person-at-device" },
  })
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await seedWorkflowRun()
})

// ── the tests ─────────────────────────────────────────────────────────────────

describe("an agentsWorkflows delegate run", () => {
  it("carries the project, its checkout and the approved profile, so it runs at all", async () => {
    const w = world(IN_SCOPE)
    const outcome = await delegateTurn(w)
    expect(outcome).toMatchObject({ kind: "answered", mode: "delegate" })
    if (outcome.kind !== "answered") return
    const run = await w.store.getRun(outcome.runId)
    expect(run).toMatchObject({
      surface: "agentsWorkflows",
      origin: "workflow",
      projectId: PROJECT_ID,
      workspaceRoot: "/repo",
      acceptanceProfileId: "unit",
      status: "succeeded",
    })
    // `patch_only`: nothing asked, and the checkout never moved.
    expect(w.workspace.applied).toHaveLength(0)
    expect(await getDb().executionRunInterrupts.count()).toBe(0)
  })

  it("parks on a person, asks on the workflow's own run, and answers the step once approved", async () => {
    const w = world(OUT_OF_SCOPE)
    const cockpit = installCockpit(w.store)
    try {
      const turn = delegateTurn(w)

      // The question reaches the cockpit on the WORKFLOW run — no second row.
      const interrupt = await waitFor(async () =>
        (await getDb().executionRunInterrupts.toArray()).find((row) => row.runId === PARENT)
      )
      expect(interrupt).toMatchObject({
        type: "fusion_approval",
        status: "pending",
        title: "scope_expansion",
        subject: expect.objectContaining({ kind: "scope_expansion" }),
      })
      const fusionRunId = interrupt.subject?.fusionRunId as string
      expect(await getExecutionRun(fusionRunId)).toBeUndefined()
      expect((await getExecutionRun(PARENT))?.status).toBe("waiting")
      // The interrupt id IS the approval's, so answering it names the digest.
      expect((await pendingApprovalOf(w.store.db, fusionRunId))?.id).toBe(interrupt.id)
      expect((await w.store.getRun(fusionRunId))?.status).toBe("waiting_for_approval")

      const result = await answer("approve", interrupt.id)
      expect(result).toMatchObject({ accepted: true })

      const outcome = await turn
      expect(outcome).toMatchObject({ kind: "answered", mode: "delegate", runId: fusionRunId })
      expect((await w.store.getRun(fusionRunId))?.status).toBe("succeeded")
      expect((await getDb().executionRunInterrupts.get(interrupt.id))?.status).toBe("approved")
      // The workflow run goes back to running once its question is answered.
      expect((await getExecutionRun(PARENT))?.status).toBe("running")
      // Verified exactly once, on the tree the resumed run staged.
      expect(w.acceptance.runs).toHaveLength(1)
    } finally {
      cockpit.dispose()
    }
  })

  it("applies the change into the workspace only after the person approves that patch", async () => {
    const w = world(IN_SCOPE)
    const cockpit = installCockpit(w.store)
    try {
      const turn = delegateTurn(w, { delegateDelivery: "workspace_updated" })
      const interrupt = await waitFor(async () =>
        (await getDb().executionRunInterrupts.toArray()).find((row) => row.runId === PARENT)
      )
      expect(interrupt).toMatchObject({ type: "fusion_approval", title: "workspace_apply" })
      expect(w.workspace.applied).toHaveLength(0)

      expect((await answer("approve", interrupt.id)).accepted).toBe(true)
      const outcome = await turn
      expect(outcome).toMatchObject({ kind: "answered", mode: "delegate" })
      if (outcome.kind !== "answered") return
      expect(w.workspace.applied).toHaveLength(1)
      const patchSets = await w.store.db.fusionPatchSets
        .where("runId")
        .equals(outcome.runId)
        .toArray()
      expect(patchSets[0]).toMatchObject({ delivery: "workspace_updated" })
      expect((await w.store.getRun(outcome.runId))?.delegateDelivery).toBe("workspace_updated")
    } finally {
      cockpit.dispose()
    }
  })

  it("reports the graph's own refusal when the person denies", async () => {
    const w = world(OUT_OF_SCOPE)
    const cockpit = installCockpit(w.store)
    try {
      const turn = delegateTurn(w)
      const interrupt = await waitFor(async () =>
        (await getDb().executionRunInterrupts.toArray()).find((row) => row.runId === PARENT)
      )
      expect((await answer("deny", interrupt.id)).accepted).toBe(true)
      const outcome = await turn
      // The denial is resumed INTO the graph, which turns it into its own
      // refusal; the run is sealed, not left parked.
      expect(outcome).toMatchObject({ kind: "refused", code: "SCOPE_EXPANSION_DENIED" })
      expect((await getDb().executionRunInterrupts.get(interrupt.id))?.status).toBe("denied")
      if (outcome.kind !== "refused") return
      expect((await w.store.getRun(outcome.runId!))?.status).toBe("failed")
    } finally {
      cockpit.dispose()
    }
  })

  it("cancels a parked run nobody can answer, releasing its money", async () => {
    const w = world(OUT_OF_SCOPE)
    const outcome = await delegateTurn(w, { parentExecutionRunId: null })
    expect(outcome).toMatchObject({ kind: "refused", code: "APPROVAL_UNREACHABLE" })
    if (outcome.kind !== "refused") return
    const run = await w.store.getRun(outcome.runId!)
    expect(run?.status).toBe("cancelled")
    expect(run?.budget.activeReservationsMicrousd).toBe(0)
    expect(await getDb().executionRunInterrupts.count()).toBe(0)
  })

  it("cancels the run and takes the question down when the step is stopped while waiting", async () => {
    const w = world(OUT_OF_SCOPE)
    const controller = new AbortController()
    const turn = delegateTurn(w, { signal: controller.signal })
    const interrupt = await waitFor(async () =>
      (await getDb().executionRunInterrupts.toArray()).find((row) => row.runId === PARENT)
    )
    controller.abort()
    const outcome = await turn
    expect(outcome).toMatchObject({ kind: "refused", code: "RUN_CANCELLED" })
    const fusionRunId = interrupt.subject?.fusionRunId as string
    expect((await w.store.getRun(fusionRunId))?.status).toBe("cancelled")
    expect((await getDb().executionRunInterrupts.get(interrupt.id))?.status).toBe("expired")
  })
})
