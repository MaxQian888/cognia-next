/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { AppSettings } from "@cognia/agent-config-types"
import { RoutingNoCandidatesError } from "@cognia/provider-routing"
import type { RoutingPlan, RoutingRequest } from "@cognia/provider-types/auto-router"
import type { ModelPricing } from "@cognia/provider-types/provider"
import { uuidFromName, type RunResult } from "@cognia/router-fusion"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import type { ChatRouteHost } from "../chat/route-chat-turn"

let store: FusionLedgerStore
jest.mock("../chat/store-provider", () => ({ currentFusionStore: async () => store }))
jest.mock("../db/outbox-appliers", () => ({ accountDatabaseAppliers: {} }))
jest.mock("../chat/chat-run-deps", () => ({ windowLeaseOwner: () => "window:test" }))
jest.mock("../calls/live-settings", () => ({
  liveSettingsReader: (snapshot: unknown) => () => snapshot,
}))
jest.mock("../chat/tenant-budget", () => ({ tightestTenantLimit: async () => null }))
jest.mock("../tools/web-evidence", () => ({ webEvidenceAvailable: () => false }))

let routeHost: ChatRouteHost
jest.mock("../api/route-host", () => ({ createRunApiRouteHost: () => routeHost }))

type Script = (runId: string) => Promise<unknown>
let script: Script
const executed: Array<{ runId: string; leaseOwner: string }> = []
jest.mock("../runtime/orchestrator-host", () => ({
  executeFusionRun: async (deps: { leaseOwner: string }, input: { runId: string }) => {
    executed.push({ runId: input.runId, leaseOwner: deps.leaseOwner })
    return script(input.runId)
  },
}))

import { isDrivingRun } from "../runtime/run-driver"
import { runAgentsWorkflowsFusion, type AgentFusionApprovalSurface } from "./agent-fusion-run"

type Ref = { providerId: string; modelId: string }
const MINI: Ref = { providerId: "openai", modelId: "gpt-5-mini" }
const GPT: Ref = { providerId: "openai", modelId: "gpt-5" }
const SONNET: Ref = { providerId: "anthropic", modelId: "claude-sonnet-5" }
const PRICES: Record<string, Partial<ModelPricing>> = {
  "openai::gpt-5-mini": { promptPer1M: 0.1, completionPer1M: 0.4 },
  "openai::gpt-5": { promptPer1M: 1, completionPer1M: 2 },
  "anthropic::claude-sonnet-5": { promptPer1M: 3, completionPer1M: 15 },
}
const APP = {
  routerFusion: { enabled: true, surfaces: { agentsWorkflows: true } },
} as unknown as AppSettings

let counter = 0

function makeRouteHost(hasFusionAncestor = false): ChatRouteHost {
  let ids = 0
  const round = ++counter
  const aliases: Record<string, Ref[]> = { fast: [MINI], powerful: [GPT], balanced: [SONNET] }
  return {
    settings: normalizeRouterFusionSettings({
      enabled: true,
      surfaces: { agentsWorkflows: true },
    }),
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
    now: () => 1_800_000_000_000,
    newId: () => uuidFromName(`agent-fusion:${round}:${++ids}`),
    hasFusionAncestor,
  }
}

async function seal(
  runId: string,
  answer: string
): Promise<{ kind: "succeeded"; result: RunResult }> {
  const lease = await store.acquireLease(runId, "window:test", 60_000)
  if (!lease.ok) throw new Error(lease.code)
  await store.startRun(runId, lease.fencingToken)
  const stored = await store.artifactStore(runId).put(answer, "text/plain", `runs/${runId}/answer`)
  const result: RunResult = {
    answer,
    answer_artifact_id: stored.artifactId,
    answer_sha256: stored.contentSha256,
    mode_executed: "panel",
    quality_status: "accepted",
    verification: {
      schema_version: "1.0.0",
      report_id: uuidFromName(`report:${runId}`),
      status: "passed",
      level: "mixed",
      checks: [],
      revision: null,
      verifier_version: "v",
      artifact_refs: [],
    },
    delivery: "answer",
    artifact_ids: [],
    warnings: [],
  }
  await store.finalizeRun(runId, lease.fencingToken, {
    status: "succeeded",
    resultArtifactId: stored.artifactId,
    events: [
      {
        type: "answer.completed",
        payload: {
          quality_status: "accepted",
          verification_status: "passed",
          verification_level: "mixed",
        },
      },
    ],
  })
  return { kind: "succeeded", result }
}

function input(overrides: Partial<Parameters<typeof runAgentsWorkflowsFusion>[0]> = {}) {
  return {
    mode: "panel" as const,
    origin: "workflow" as const,
    featureId: "workflow:step-1",
    messages: [
      { role: "system" as const, content: "Answer with sources." },
      { role: "user" as const, content: "Compare the 2024 and 2025 steel tariffs." },
    ],
    hasFusionAncestor: false,
    appSettings: APP,
    ...overrides,
  }
}

beforeEach(() => {
  const name = `agent-fusion-run-test-${++counter}`
  store = new FusionLedgerStore({ db: new FusionDB(name), codec: fusionContentCodec(name) })
  routeHost = makeRouteHost()
  executed.length = 0
  script = (runId) => seal(runId, "Both tariffs rose.")
})

describe("runAgentsWorkflowsFusion", () => {
  it("creates a session-less run on the agentsWorkflows surface and answers with it", async () => {
    const outcome = await runAgentsWorkflowsFusion(input())
    expect(outcome.kind).toBe("answered")
    if (outcome.kind !== "answered") return
    expect(outcome.text).toBe("Both tariffs rose.")
    expect(outcome.mode).toBe("panel")
    expect(outcome.qualityStatus).toBe("accepted")
    expect(executed).toHaveLength(1)

    const run = await store.getRun(outcome.runId)
    // D21: the caller keeps the session lock — the run holds none of its own.
    expect(run?.sessionId).toBeNull()
    expect(run?.surface).toBe("agentsWorkflows")
    expect(run?.origin).toBe("workflow")
    expect(run?.writesSessionTranscript).not.toBe(true)
    const locks = await store.db.fusionSessionLocks.toArray()
    expect(locks).toEqual([])
  })

  it("books the run under the caller's own origin", async () => {
    const outcome = await runAgentsWorkflowsFusion(input({ origin: "agent" }))
    if (outcome.kind !== "answered") throw new Error(outcome.code)
    expect((await store.getRun(outcome.runId))?.origin).toBe("agent")
  })

  it("[ACC:INV-09] refuses a fusion run under a fusion ancestor with FUSION_RECURSION", async () => {
    routeHost = makeRouteHost(true)
    const outcome = await runAgentsWorkflowsFusion(input({ hasFusionAncestor: true }))
    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused") return
    expect(outcome.code).toBe("ROUTE_NO_SOLUTION")
    expect(outcome.reasons.some((reason) => reason.endsWith(":FUSION_RECURSION"))).toBe(true)
    // Nothing was created, so nothing was reserved.
    expect(await store.db.fusionRuns.count()).toBe(0)
    expect(executed).toHaveLength(0)
  })

  it("refuses a prompt that carries personal data before anything is stored", async () => {
    const outcome = await runAgentsWorkflowsFusion(
      input({
        messages: [{ role: "user", content: "mail jane.doe@example.com the tariff table" }],
      })
    )
    expect(outcome).toMatchObject({ kind: "refused", code: "PII_BLOCKED" })
    expect(await store.db.fusionRuns.count()).toBe(0)
  })

  it("reports a run that failed rather than answering with something else", async () => {
    script = async () => ({ kind: "failed", code: "VERIFICATION_FAILED", message: "no evidence" })
    const outcome = await runAgentsWorkflowsFusion(input())
    expect(outcome).toMatchObject({ kind: "refused", code: "VERIFICATION_FAILED" })
    if (outcome.kind !== "refused") return
    expect(outcome.runId).toBeDefined()
  })

  it("reports a cancelled run as a refusal, not an empty answer", async () => {
    script = async () => ({ kind: "cancelled" })
    const outcome = await runAgentsWorkflowsFusion(input())
    expect(outcome).toMatchObject({ kind: "refused", code: "RUN_CANCELLED" })
  })

  describe("a run that parks on a person", () => {
    const APPROVAL = {
      approvalId: "11111111-2222-4333-8444-555555555555",
      kind: "scope_expansion" as const,
      requestDigest: "d".repeat(64),
      revision: "rev-0",
      logicalStepId: "delegate:scope",
      args: {},
      summary: { paths: ["tests/a.ts"], fileCount: 1 } as never,
    }

    function recorder(raises = true) {
      const raised: unknown[] = []
      const withdrawn: unknown[] = []
      const surface: AgentFusionApprovalSurface = {
        raise: async (call) => {
          raised.push(call)
          return raises
        },
        withdraw: async (call) => {
          withdrawn.push(call)
        },
      }
      return { surface, raised, withdrawn }
    }

    const parked = async () => ({
      kind: "waiting" as const,
      code: "WAITING_FOR_APPROVAL" as const,
      message: "waiting",
      approval: APPROVAL,
    })

    it("asks on the caller's run, then drives the resumed run on to its answer", async () => {
      const { surface, raised } = recorder()
      let calls = 0
      let heldWhileWaiting = false
      script = async (runId) => {
        calls += 1
        heldWhileWaiting = isDrivingRun(runId)
        return calls === 1 ? parked() : seal(runId, "Fixed.")
      }
      const outcome = await runAgentsWorkflowsFusion(
        input({ parentExecutionRunId: "execution:workflow:wf-1" }),
        { approvals: surface, approvalPollMs: 1, sleep: async () => {} }
      )
      expect(outcome).toMatchObject({ kind: "answered", text: "Fixed." })
      expect(raised).toEqual([
        expect.objectContaining({
          parentExecutionRunId: "execution:workflow:wf-1",
          approval: APPROVAL,
        }),
      ])
      // The caller held the run's driver, so a cockpit `driveRun` joined nothing.
      expect(heldWhileWaiting).toBe(true)
      if (outcome.kind === "answered") expect(isDrivingRun(outcome.runId)).toBe(false)
    })

    it("keeps waiting while the run is parked, and gives up at the approval's expiry", async () => {
      const { surface, withdrawn } = recorder()
      let now = Date.now()
      script = async (runId) => {
        const run = (await store.getRun(runId))!
        await store.db.fusionRuns.put({ ...run, status: "waiting_for_approval" })
        return parked()
      }
      const sleeps: number[] = []
      const outcome = await runAgentsWorkflowsFusion(
        input({ parentExecutionRunId: "execution:team:t-1" }),
        {
          approvals: surface,
          approvalPollMs: 7,
          now: () => now,
          sleep: async (ms) => {
            sleeps.push(ms)
            now += 60 * 60 * 1000
          },
        }
      )
      expect(outcome).toMatchObject({ kind: "refused", code: "APPROVAL_EXPIRED" })
      expect(sleeps.length).toBeGreaterThan(0)
      expect(sleeps.every((ms) => ms === 7)).toBe(true)
      expect(withdrawn).toEqual([
        { parentExecutionRunId: "execution:team:t-1", approvalId: APPROVAL.approvalId },
      ])
      if (outcome.kind === "refused") {
        expect((await store.getRun(outcome.runId!))?.status).toBe("cancelled")
      }
    })

    it("cancels a parked run whose caller's run cannot carry the question", async () => {
      const { surface } = recorder(false)
      script = async () => parked()
      const outcome = await runAgentsWorkflowsFusion(
        input({ parentExecutionRunId: "execution:workflow:gone" }),
        { approvals: surface }
      )
      expect(outcome).toMatchObject({ kind: "refused", code: "APPROVAL_UNREACHABLE" })
      if (outcome.kind === "refused") {
        expect((await store.getRun(outcome.runId!))?.status).toBe("cancelled")
      }
    })

    it("reads back the seal of a run another window drove after the decision", async () => {
      const { surface } = recorder()
      let calls = 0
      script = async () => {
        calls += 1
        if (calls === 1) return parked()
        return { kind: "busy" as const }
      }
      let sealedElsewhere = false
      const outcome = await runAgentsWorkflowsFusion(
        input({ parentExecutionRunId: "execution:workflow:wf-2" }),
        {
          approvals: surface,
          sleep: async () => {
            if (sealedElsewhere) return
            sealedElsewhere = true
            const runId = (await store.db.fusionRuns.toArray())[0]!.runId
            // Another worker's seal, with the result record the orchestrator writes.
            const lease = await store.acquireLease(runId, "window:other", 60_000)
            if (!lease.ok) throw new Error(lease.code)
            await store.startRun(runId, lease.fencingToken)
            const artifacts = store.artifactStore(runId)
            const answer = await artifacts.put("From elsewhere.", "text/plain", `a/${runId}`)
            const record = await artifacts.put(
              JSON.stringify({
                answer_artifact_id: answer.artifactId,
                answer_sha256: answer.contentSha256,
                mode_executed: "delegate",
                quality_status: "accepted",
                verification: {
                  schema_version: "1.0.0",
                  report_id: uuidFromName(`report:${runId}`),
                  status: "passed",
                  level: "tool_verified",
                  checks: [],
                  revision: null,
                  verifier_version: "v",
                  artifact_refs: [],
                },
                delivery: "patch_only",
                artifact_ids: [],
                warnings: [],
              }),
              "application/json",
              `r/${runId}`
            )
            await store.finalizeRun(runId, lease.fencingToken, {
              status: "succeeded",
              resultArtifactId: answer.artifactId,
              resultRecordArtifactId: record.artifactId,
            })
          },
        }
      )
      expect(outcome).toMatchObject({ kind: "answered", text: "From elsewhere." })
    })
  })
})
