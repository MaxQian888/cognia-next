/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { AppSettings, RouterFusionRunSummary } from "@cognia/agent-config-types"
import { RoutingNoCandidatesError } from "@cognia/provider-routing"
import type { RoutingPlan, RoutingRequest } from "@cognia/provider-types/auto-router"
import type { ModelPricing } from "@cognia/provider-types/provider"
import { uuidFromName, type RunResult } from "@cognia/router-fusion"
import {
  normalizeRouterFusionSettings,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import { answerMessageId } from "../db/session-transcript"
import type { ChatRouteHost } from "./route-chat-turn"

let store: FusionLedgerStore
jest.mock("./store-provider", () => ({ currentFusionStore: async () => store }))
jest.mock("../db/outbox-appliers", () => ({ accountDatabaseAppliers: {} }))
jest.mock("./chat-run-deps", () => ({ windowLeaseOwner: () => "window:test" }))
jest.mock("../calls/live-settings", () => ({
  liveSettingsReader: (snapshot: unknown) => () => snapshot,
}))
let tenantLimit: number | null = null
jest.mock("./tenant-budget", () => ({ tightestTenantLimit: async () => tenantLimit }))

type Script = (runId: string, signal: AbortSignal | undefined) => Promise<unknown>
let script: Script
const executed: Array<{ runId: string; messages: unknown; leaseOwner: string }> = []
jest.mock("../runtime/orchestrator-host", () => ({
  executeFusionRun: async (
    deps: { leaseOwner: string },
    input: { runId: string; messages: unknown; signal?: AbortSignal }
  ) => {
    executed.push({ runId: input.runId, messages: input.messages, leaseOwner: deps.leaseOwner })
    return script(input.runId, input.signal)
  },
}))

import {
  __resetChatFusionTurnsForTesting,
  activeChatFusionRun,
  cancelChatFusionTurn,
  chatAutoConsidersFusion,
  selectChatFusionRun,
  startChatFusionTurn,
  type ChatFusionSelectionInput,
} from "./chat-fusion-turn"

type Ref = { providerId: string; modelId: string }
const MINI: Ref = { providerId: "openai", modelId: "gpt-5-mini" }
const GPT: Ref = { providerId: "openai", modelId: "gpt-5" }
const SONNET: Ref = { providerId: "anthropic", modelId: "claude-sonnet-5" }
const PRICES: Record<string, Partial<ModelPricing>> = {
  "openai::gpt-5-mini": { promptPer1M: 0.1, completionPer1M: 0.4 },
  "openai::gpt-5": { promptPer1M: 1, completionPer1M: 2 },
  "anthropic::claude-sonnet-5": { promptPer1M: 3, completionPer1M: 15 },
}
const APP = { routerFusion: { enabled: true, surfaces: { chat: true } } } as unknown as AppSettings
let counter = 0

function makeHost(
  settings: Partial<RouterFusionSettings> = {},
  aliases: Record<string, Ref[]> = { fast: [MINI], powerful: [GPT], balanced: [SONNET] }
) {
  let ids = 0
  const round = ++counter
  const host: ChatRouteHost = {
    settings: normalizeRouterFusionSettings({
      enabled: true,
      surfaces: { chat: true },
      ...settings,
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
        surface: "chat",
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
    newId: () => uuidFromName(`chat-fusion:${round}:${++ids}`),
  }
  return host
}

function selection(overrides: Partial<ChatFusionSelectionInput> = {}): ChatFusionSelectionInput {
  return {
    requested: "panel",
    sessionId: "session-1",
    promptText: "Compare the 2024 and 2025 steel tariffs and cite sources.",
    hasImages: false,
    webToolsAvailable: false,
    ...overrides,
  }
}

const MESSAGES = [
  { role: "user" as const, content: "What was the tariff in 2024?" },
  { role: "assistant" as const, content: "2%." },
  { role: "user" as const, content: "Compare the 2024 and 2025 steel tariffs and cite sources." },
]

async function leased(runId: string) {
  const lease = await store.acquireLease(runId, "window:test", 60_000)
  if (!lease.ok) throw new Error(lease.code)
  await store.startRun(runId, lease.fencingToken)
  return lease.fencingToken
}

/** What the orchestrator does to a run it finishes: phases, then the sealed answer. */
async function seal(
  runId: string,
  answer: string
): Promise<{ kind: "succeeded"; result: RunResult }> {
  const token = await leased(runId)
  await store.appendWorkflowEvent(runId, token, "phase.changed", { phase: "prepare", members: 2 })
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
  await store.finalizeRun(runId, token, {
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

function start(stamp: Parameters<typeof startChatFusionTurn>[0]["stamp"], sessionId = "session-1") {
  return startChatFusionTurn({
    sessionId,
    stamp,
    messages: MESSAGES,
    workspaceRoot: null,
    appSettings: APP,
  })
}

beforeEach(() => {
  const name = `chat-fusion-turn-test-${++counter}`
  store = new FusionLedgerStore({ db: new FusionDB(name), codec: fusionContentCodec(name) })
  executed.length = 0
  tenantLimit = null
  __resetChatFusionTurnsForTesting()
})

describe("chatAutoConsidersFusion", () => {
  it("asks the fusion router only for an approved fusion row and a turn that needs no agent tools", () => {
    const approved = normalizeRouterFusionSettings({ approvedRuleRows: ["panel_research"] })
    const economyOnly = normalizeRouterFusionSettings({ approvedRuleRows: ["economy_simple"] })
    expect(chatAutoConsidersFusion(approved, false)).toBe(true)
    expect(chatAutoConsidersFusion(approved, true)).toBe(false)
    expect(chatAutoConsidersFusion(economyOnly, false)).toBe(false)
  })
})

describe("selectChatFusionRun", () => {
  it("routes an explicit panel to independent members and stamps the turn", async () => {
    const picked = await selectChatFusionRun(makeHost(), selection())
    expect(picked.kind).toBe("fusion")
    if (picked.kind !== "fusion") return
    expect(picked.stamp).toMatchObject({
      mode: "panel",
      actionId: "panel_review",
      requested: "panel",
      ruleId: "R1_explicit_mode",
      budgetMode: "tracked",
      acceptanceProfile: "evidence_review",
      capMicrousd: 2_000_000,
      roles: {
        panel_a: "openai::gpt-5-mini",
        panel_b: "anthropic::claude-sonnet-5",
        judge: "openai::gpt-5",
        synthesizer: "openai::gpt-5",
      },
    })
  })

  it("refuses an explicit mode it cannot run, with the router's reasons", async () => {
    const samePanel = await selectChatFusionRun(
      makeHost({}, { fast: [GPT], powerful: [GPT], balanced: [GPT] }),
      selection()
    )
    expect(samePanel.kind).toBe("refused")
    if (samePanel.kind === "refused") expect(samePanel.reasons.join(" ")).toContain("panel_review")
    await expect(selectChatFusionRun(makeHost(), selection({ hasImages: true }))).resolves.toEqual({
      kind: "refused",
      code: "FUSION_TEXT_ONLY",
      reasons: ["attachments:image"],
      decision: null,
    })
  })

  it("raises the data class to what the conversation's project says", async () => {
    const host = makeHost({ dataClassByWorkspaceId: { "project-1": "restricted" } })
    const restricted = await selectChatFusionRun(host, selection({ workspaceId: "project-1" }))
    expect(restricted).toMatchObject({ kind: "refused", code: "ROUTE_NO_SOLUTION" })
    await expect(
      selectChatFusionRun(host, selection({ workspaceId: "project-2" }))
    ).resolves.toMatchObject({
      kind: "fusion",
    })
    // Auto never refuses: the direct path routes the turn under the same class.
    await expect(
      selectChatFusionRun(
        makeHost({
          approvedRuleRows: ["panel_research"],
          dataClassByWorkspaceId: { "project-1": "restricted" },
        }),
        selection({ requested: "auto", workspaceId: "project-1" })
      )
    ).resolves.toEqual({ kind: "direct" })
  })

  it("hands Auto back to the direct path unless an approved fusion row takes the turn", async () => {
    await expect(
      selectChatFusionRun(makeHost(), selection({ requested: "auto" }))
    ).resolves.toEqual({
      kind: "direct",
    })
    await expect(
      selectChatFusionRun(makeHost(), selection({ requested: "auto", hasImages: true }))
    ).resolves.toEqual({ kind: "direct" })
    const research = await selectChatFusionRun(
      makeHost({ approvedRuleRows: ["panel_research"] }),
      selection({ requested: "auto", webToolsAvailable: true })
    )
    expect(research).toMatchObject({
      kind: "fusion",
      stamp: { mode: "panel", requested: "auto", ruleId: "R4_panel_research" },
    })
  })
})

describe("startChatFusionTurn", () => {
  it("[ACC:SSE-02] creates an answer-only run, executes it and hands back the verified answer with its card", async () => {
    const picked = await selectChatFusionRun(makeHost(), selection())
    if (picked.kind !== "fusion") throw new Error("not routed")
    const runId = picked.stamp.runId
    const progress: RouterFusionRunSummary[] = []
    let activeDuring: string | undefined
    script = async (id) => {
      activeDuring = activeChatFusionRun("session-1")
      const token = await leased(id)
      // Long enough for a progress tick to see the run moving.
      await store.appendWorkflowEvent(id, token, "phase.changed", { phase: "prepare", members: 2 })
      await new Promise((resolve) => setTimeout(resolve, 800))
      return seal(id, "The 2025 steel tariff is 4%.")
    }
    const outcome = await startChatFusionTurn({
      sessionId: "session-1",
      stamp: picked.stamp,
      messages: MESSAGES,
      workspaceRoot: "/work/project",
      appSettings: APP,
      onProgress: (summary) => progress.push(summary),
    })
    expect(outcome.kind).toBe("succeeded")
    if (outcome.kind !== "succeeded") return
    expect(activeDuring).toBe(runId)
    expect(activeChatFusionRun("session-1")).toBeUndefined()
    expect(executed).toEqual([{ runId, messages: MESSAGES, leaseOwner: "window:test" }])
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0]).toMatchObject({ runId, mode: "panel", status: "running" })

    expect(outcome.answer).toEqual({
      id: answerMessageId(runId),
      role: "assistant",
      parts: [{ type: "text", text: "The 2025 steel tariff is 4%." }],
      metadata: {
        routerFusion: { runId, mode: "panel", origin: "chat" },
        run: { routerFusion: { fusion: outcome.summary } },
      },
    })
    expect(outcome.summary).toMatchObject({
      status: "succeeded",
      qualityStatus: "accepted",
      actionId: "panel_review",
      timeline: { candidates: { members: 2 }, verification: { status: "passed" } },
    })

    const run = await store.getRun(runId)
    expect(run).toMatchObject({
      surface: "chat",
      origin: "chat",
      driver: "orchestrator",
      writesSessionAnswer: true,
      workspaceRoot: "/work/project",
      sessionId: "session-1",
      acceptanceProfile: "evidence_review",
    })
    expect(run?.writesSessionTranscript).toBeUndefined()
    // The stored input is bound to its run.
    const input = await store.db.fusionArtifacts.get(run!.inputArtifactId!)
    expect(input?.runId).toBe(runId)
    // Durable in the same step: the outbox holds the answer effect.
    const effects = await store.db.fusionOutbox.where("kind").equals("session_message").toArray()
    expect(effects.map((row) => row.effectId)).toEqual([`session:${runId}:answer`])
  })

  it("never runs a route this session did not seal, or one it already used", async () => {
    const picked = await selectChatFusionRun(makeHost(), selection())
    if (picked.kind !== "fusion") throw new Error("not routed")
    await expect(start(picked.stamp, "session-2")).resolves.toEqual({
      kind: "refused",
      code: "ROUTE_EXPIRED",
    })
    script = (id) => seal(id, "ok")
    await start(picked.stamp)
    await expect(start(picked.stamp)).resolves.toEqual({ kind: "refused", code: "ROUTE_EXPIRED" })
    expect(executed).toHaveLength(1)
  })

  it("refuses a conversation that fails the PII gate before storing or reserving anything", async () => {
    const picked = await selectChatFusionRun(makeHost(), selection())
    if (picked.kind !== "fusion") throw new Error("not routed")
    await expect(
      startChatFusionTurn({
        sessionId: "session-1",
        stamp: picked.stamp,
        messages: [...MESSAGES, { role: "user", content: "and mail it to jane.doe@example.com" }],
        workspaceRoot: null,
        appSettings: APP,
      })
    ).resolves.toEqual({ kind: "refused", code: "PII_BLOCKED" })
    expect(executed).toHaveLength(0)
    expect(await store.db.fusionRuns.count()).toBe(0)
    expect(await store.db.fusionArtifacts.count()).toBe(0)
    // The sealed route was used up: a resend routes again.
    await expect(start(picked.stamp)).resolves.toEqual({ kind: "refused", code: "ROUTE_EXPIRED" })
  })

  it("refuses a run the tenant budget cannot hold, spending nothing", async () => {
    tenantLimit = 10
    const picked = await selectChatFusionRun(makeHost(), selection())
    if (picked.kind !== "fusion") throw new Error("not routed")
    await expect(start(picked.stamp)).resolves.toEqual({
      kind: "refused",
      code: "TENANT_BUDGET_EXHAUSTED",
    })
    expect(executed).toHaveLength(0)
  })

  it("reports a failed run with its code and summary, and writes no answer", async () => {
    const picked = await selectChatFusionRun(makeHost(), selection())
    if (picked.kind !== "fusion") throw new Error("not routed")
    script = async (id) => {
      const token = await leased(id)
      await store.finalizeRun(id, token, {
        status: "failed",
        error: { code: "FUSION_INSUFFICIENT_CANDIDATES", message: "one candidate" },
      })
      return { kind: "failed", code: "FUSION_INSUFFICIENT_CANDIDATES", message: "one candidate" }
    }
    await expect(start(picked.stamp)).resolves.toMatchObject({
      kind: "failed",
      code: "FUSION_INSUFFICIENT_CANDIDATES",
      summary: { status: "failed", errorCode: "FUSION_INSUFFICIENT_CANDIDATES" },
    })
    expect(await store.db.fusionOutbox.where("kind").equals("session_message").count()).toBe(0)
  })

  it("stops a running turn when the person cancels it", async () => {
    const picked = await selectChatFusionRun(makeHost(), selection())
    if (picked.kind !== "fusion") throw new Error("not routed")
    expect(await cancelChatFusionTurn("session-1")).toBe(false)
    let cancelled = false
    let statusAfterCancel: string | undefined
    script = async (id) => {
      const token = await leased(id)
      cancelled = await cancelChatFusionTurn("session-1")
      statusAfterCancel = (await store.getRun(id))?.status
      await store.finalizeRun(id, token, { status: "cancelled" })
      return { kind: "cancelled" }
    }
    await expect(start(picked.stamp)).resolves.toMatchObject({
      kind: "cancelled",
      summary: { status: "cancelled" },
    })
    expect(cancelled).toBe(true)
    expect(statusAfterCancel).toBe("cancelling")
  })
})
