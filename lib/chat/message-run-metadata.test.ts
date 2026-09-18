import type { UIMessage } from "ai"
import type { RouterFusionRunSummary, RouterFusionTurnStamp } from "@cognia/agent-config-types"
import type { RoutingPlan } from "@cognia/provider-types/auto-router"
import {
  attachRunMetadataToLastAssistant,
  attachUsageToLastAssistant,
  buildCompletedRunMetadata,
  buildRouterFusionRunMetadata,
  buildRoutingRunMetadata,
  runMetadataOf,
} from "./message-run-metadata"

const messages = (): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "hi" }],
    metadata: { branchGroupId: "b1" },
  },
]

describe("assistant run metadata", () => {
  it("attaches an immutable run snapshot to the last assistant and preserves metadata", () => {
    const next = attachRunMetadataToLastAssistant(messages(), {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      startedAt: 100,
      completedAt: 250,
      durationMs: 150,
      finishReason: "success",
    })

    expect(next[1].metadata).toEqual({
      branchGroupId: "b1",
      run: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
        startedAt: 100,
        completedAt: 250,
        durationMs: 150,
        finishReason: "success",
      },
    })
    expect(messages()[1].metadata).toEqual({ branchGroupId: "b1" })
  })

  it("does not invent unavailable fields or modify an imported message", () => {
    const imported = messages()
    expect(runMetadataOf(imported[1])).toBeUndefined()
    expect(attachRunMetadataToLastAssistant(imported, {})).toBe(imported)
  })

  it("prefers a provider-reported duration and preserves partially reported fields", () => {
    expect(
      buildCompletedRunMetadata({
        providerId: "external",
        completedAt: 500,
        reportedDurationMs: 42,
      })
    ).toEqual({
      providerId: "external",
      modelId: undefined,
      startedAt: undefined,
      completedAt: 500,
      durationMs: 42,
      finishReason: undefined,
    })
  })

  it("derives duration only when start time is known and never guesses model attribution", () => {
    expect(buildCompletedRunMetadata({ startedAt: 100, completedAt: 250 })).toMatchObject({
      startedAt: 100,
      completedAt: 250,
      durationMs: 150,
    })
    expect(buildCompletedRunMetadata({ completedAt: 250 })).toEqual({
      providerId: undefined,
      modelId: undefined,
      startedAt: undefined,
      completedAt: 250,
      durationMs: undefined,
      finishReason: undefined,
    })
  })

  it("merges partial updates and leaves inputs without an assistant untouched", () => {
    const existing = messages()
    existing[1] = { ...existing[1], metadata: { run: { startedAt: 100 } } }
    const merged = attachRunMetadataToLastAssistant(existing, { completedAt: 200 })
    expect(runMetadataOf(merged[1])).toEqual({ startedAt: 100, completedAt: 200 })

    const userOnly = [messages()[0]]
    expect(attachRunMetadataToLastAssistant(userOnly, { completedAt: 200 })).toBe(userOnly)
  })

  it("passes the routing record through to the completed snapshot", () => {
    const routing = {
      mode: "auto" as const,
      strategy: "reliability",
      reasonCodes: ["auto-task-fit"],
      candidateCount: 2,
    }
    expect(buildCompletedRunMetadata({ completedAt: 500, routing }).routing).toEqual(routing)
  })

  it("seals the turn's preset identity so the header survives later switches", () => {
    const agent = { presetId: "build", name: "Build", icon: "Hammer" }
    const sealed = buildCompletedRunMetadata({ completedAt: 500, agent })
    expect(sealed.agent).toEqual(agent)

    const merged = attachRunMetadataToLastAssistant(messages(), sealed)
    expect(runMetadataOf(merged[1])?.agent).toEqual(agent)

    // A turn with no resolved composition stamps nothing rather than a guess.
    expect(buildCompletedRunMetadata({ completedAt: 500 }).agent).toBeUndefined()
  })
})

describe("buildRouterFusionRunMetadata", () => {
  const route: RouterFusionTurnStamp = {
    runId: "rf-1",
    decisionId: "dec-1",
    actionId: "direct_baseline",
    mode: "direct",
    ruleId: null,
    deploymentId: "openai::gpt-5",
    providerId: "openai",
    modelId: "gpt-5",
    budgetMode: "tracked",
    capMicrousd: 500_000,
    reserveEstimateMicrousd: 12_000,
    priceKnown: true,
    acceptanceProfile: "text_basic",
    lane: "ai-sdk",
  }
  const sealed = {
    status: "succeeded",
    spentMicrousd: 4_200,
    overspendMicrousd: 0,
    modelCalls: 2,
    costStatus: "actual",
    frozen: false,
    refusalCode: null,
    bypass: null,
  }

  it("[ACC:OFF-02] is undefined for a turn that never touched Router + Fusion", () => {
    expect(buildRouterFusionRunMetadata({}, null)).toBeUndefined()
    expect(buildRouterFusionRunMetadata(undefined, null)).toBeUndefined()
    expect(buildCompletedRunMetadata({ completedAt: 1 })).not.toHaveProperty("routerFusion")
  })

  it("copies the route and the sealed run as plain data", () => {
    const metadata = buildRouterFusionRunMetadata({ routerFusion: route }, sealed)
    expect(metadata).toEqual({
      route,
      outcome: {
        status: "succeeded",
        spentMicrousd: 4_200,
        overspendMicrousd: 0,
        modelCalls: 2,
        costStatus: "actual",
        frozen: false,
        refusalCode: null,
      },
    })
    expect(metadata?.route).not.toBe(route)
    expect(buildCompletedRunMetadata({ completedAt: 1, routerFusion: metadata }).routerFusion).toBe(
      metadata
    )
  })

  it("reads a cascade or panel run's summary off its answer message", () => {
    const fusion: RouterFusionRunSummary = {
      runId: "rf-2",
      mode: "panel",
      actionId: "panel_review",
      ruleId: "R1_explicit_mode",
      status: "succeeded",
      qualityStatus: "accepted",
      roles: { judge: "openai::gpt-5" },
      capMicrousd: 2_000_000,
      spentMicrousd: 91_000,
      modelCalls: 5,
      costStatus: "actual",
      errorCode: null,
      timeline: {
        phases: [{ phase: "judge", step: "reported", at: 5 }],
        calls: { started: 5, finished: 5, unknown: 0 },
        candidates: { members: 2, rejected: 0, evidenceRejected: 0 },
        judge: { supported: 3, rejected: 1, unverified: 0, contradictions: 0, unresolved: 0 },
        escalated: null,
        degraded: null,
        verification: { status: "passed", level: "model_review" },
        compactions: 0,
      },
    }
    const answer: UIMessage = {
      id: "rf-rf-2-answer",
      role: "assistant",
      parts: [{ type: "text", text: "verified" }],
      metadata: {
        routerFusion: { runId: "rf-2", mode: "panel", origin: "chat" },
        run: { routerFusion: { fusion } },
      },
    }
    expect(runMetadataOf(answer)?.routerFusion?.fusion).toEqual(fusion)
    expect(runMetadataOf(answer)?.routerFusion?.route).toBeUndefined()
  })

  it("[ACC:ISO-01] records a bypass from the send or from a fault during the turn", () => {
    expect(
      buildRouterFusionRunMetadata(
        { routerFusionBypass: { code: "db_unavailable", justTripped: true } },
        null
      )
    ).toEqual({ bypass: { code: "db_unavailable", justTripped: true } })
    expect(
      buildRouterFusionRunMetadata(
        { routerFusion: route },
        { ...sealed, bypass: { code: "sidecar_unanswered", justTripped: false } }
      )?.bypass
    ).toEqual({ code: "sidecar_unanswered", justTripped: false })
  })
})

describe("buildRoutingRunMetadata", () => {
  const plan = (over: Partial<RoutingPlan> = {}): RoutingPlan =>
    ({
      decisionId: "d1",
      surface: "chat",
      requested: { kind: "auto" },
      strategy: "reliability",
      selected: { providerId: "anthropic", modelId: "claude-opus-4-8" },
      orderedCandidates: [
        { providerId: "anthropic", modelId: "claude-opus-4-8" },
        { providerId: "anthropic", modelId: "claude-sonnet-4-6" },
      ],
      reasonCodes: ["auto-task-fit", "reliability-first"],
      rejected: [],
      replayPolicy: "pre-commit-only",
      createdAt: 1,
      ...over,
    }) as RoutingPlan

  it("is undefined without a plan — a manual send has no routing story", () => {
    expect(
      buildRoutingRunMetadata({ autoRouting: { score: 0.9, tier: "powerful" } })
    ).toBeUndefined()
  })

  it("projects mode, strategy, reason codes and candidate count off the plan", () => {
    expect(
      buildRoutingRunMetadata({
        routingPlan: plan(),
        aliasResolution: {
          alias: "powerful",
          resolvedTo: { providerId: "anthropic", modelId: "claude-opus-4-8" },
          fallbackEntries: [],
        },
      })
    ).toEqual({
      mode: "auto",
      alias: "powerful",
      strategy: "reliability",
      reasonCodes: ["auto-task-fit", "reliability-first"],
      candidateCount: 2,
    })
  })

  it("prefers the plan's difficulty over the earlier autoRouting stamp, keeping score 0", () => {
    const withDifficulty = plan({
      difficulty: {
        score: 0,
        tier: "fast",
        deterministicTier: "fast",
        signals: {
          length: 0,
          code: 0,
          keywords: 0,
          structure: 0,
          attachments: 0,
          threadDepth: 0,
          tools: 0,
          effortFloor: 0,
        },
        judgeUsed: true,
      },
    })
    const meta = buildRoutingRunMetadata({
      routingPlan: withDifficulty,
      autoRouting: { score: 0.9, tier: "powerful" },
    })
    expect(meta).toMatchObject({ tier: "fast", score: 0, judgeUsed: true })
  })

  it("falls back to the autoRouting stamp when the plan carries no difficulty", () => {
    const meta = buildRoutingRunMetadata({
      routingPlan: plan({ requested: { kind: "alias", alias: "fast" } }),
      autoRouting: { score: 0.2, tier: "fast" },
    })
    expect(meta).toMatchObject({ mode: "alias", tier: "fast", score: 0.2 })
    expect(meta).not.toHaveProperty("judgeUsed")
  })

  it("never reports an alias on a manual-mode plan", () => {
    const meta = buildRoutingRunMetadata({
      routingPlan: plan({
        requested: { kind: "manual", providerId: "anthropic", modelId: "claude-opus-4-8" },
      }),
      aliasResolution: {
        alias: "powerful",
        resolvedTo: { providerId: "anthropic", modelId: "claude-opus-4-8" },
        fallbackEntries: [],
      },
    })
    expect(meta).toMatchObject({ mode: "manual" })
    expect(meta).not.toHaveProperty("alias")
  })
})

describe("attachUsageToLastAssistant", () => {
  const usageOf = (list: UIMessage[]) =>
    (list[1].metadata as { usage?: Record<string, unknown> }).usage

  it("stamps the turn's tokens on the newest assistant without losing its metadata", () => {
    const next = attachUsageToLastAssistant(messages(), {
      inputTokens: 120,
      contextTokens: 41_000,
      contextWindow: 272_000,
    })
    expect(usageOf(next)).toEqual({
      inputTokens: 120,
      contextTokens: 41_000,
      contextWindow: 272_000,
    })
    expect((next[1].metadata as { branchGroupId?: string }).branchGroupId).toBe("b1")
  })

  it("merges into an existing usage object instead of replacing it", () => {
    const seeded = messages()
    seeded[1] = {
      ...seeded[1],
      metadata: { ...(seeded[1].metadata as object), usage: { inputTokens: 5, outputTokens: 9 } },
    } as UIMessage
    expect(usageOf(attachUsageToLastAssistant(seeded, { outputTokens: 12 }))).toEqual({
      inputTokens: 5,
      outputTokens: 12,
    })
  })

  it("is a no-op for an empty patch or a transcript with no assistant", () => {
    const list = messages()
    expect(attachUsageToLastAssistant(list, {})).toBe(list)
    const userOnly: UIMessage[] = [{ id: "u1", role: "user", parts: [] }]
    expect(attachUsageToLastAssistant(userOnly, { inputTokens: 1 })).toBe(userOnly)
  })
})
