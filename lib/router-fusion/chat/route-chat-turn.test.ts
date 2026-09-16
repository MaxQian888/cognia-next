import { RoutingNoCandidatesError } from "@cognia/provider-routing"
import type { RoutingPlan, RoutingRequest } from "@cognia/provider-types/auto-router"
import type { ModelPricing } from "@cognia/provider-types/provider"
import {
  DEFAULT_ROUTER_FUSION_SETTINGS,
  normalizeRouterFusionSettings,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"
import type { AppSettings } from "@cognia/agent-config-types"

import {
  chatFeatures,
  dataClassFor,
  isSubscriptionEnv,
  liveRefusalFor,
  sealChatRoute,
  selectChatDeployment,
  type ChatRouteHost,
  type ChatSelectionInput,
} from "./route-chat-turn"

type Ref = { providerId: string; modelId: string }
const GPT: Ref = { providerId: "openai", modelId: "gpt-5" }
const GPT_BACKUP: Ref = { providerId: "azure", modelId: "gpt-5" }
const MINI: Ref = { providerId: "openai", modelId: "gpt-5-mini" }
const CLAUDE: Ref = { providerId: "anthropic", modelId: "claude-opus-5" }
const PRICEY: Ref = { providerId: "openai", modelId: "o-pro" }

const PRICES: Record<string, Partial<ModelPricing>> = {
  "openai::gpt-5": { promptPer1M: 1, completionPer1M: 2 },
  "azure::gpt-5": { promptPer1M: 1, completionPer1M: 2 },
  "openai::gpt-5-mini": { promptPer1M: 0.1, completionPer1M: 0.4 },
  "anthropic::claude-opus-5": { promptPer1M: 5, completionPer1M: 25 },
  "openai::o-pro": { promptPer1M: 60, completionPer1M: 240 },
}

function planFor(refs: Ref[], request: RoutingRequest): RoutingPlan {
  const candidates = refs.map((ref) => ({
    ...ref,
    deploymentId: `${ref.providerId}::${ref.modelId}`,
    reasonCodes: [],
  }))
  return {
    decisionId: "plan-1",
    surface: "chat",
    requested: request.selection,
    strategy: "priority",
    selected: candidates[0],
    orderedCandidates: candidates,
    reasonCodes: [],
    rejected: [],
    costCap: { capUsd: 0.01, exceeded: true },
    replayPolicy: "pre-commit-only",
    createdAt: 0,
  } as RoutingPlan
}

function makeHost(
  options: {
    settings?: Partial<RouterFusionSettings>
    aliases?: Record<string, Ref[]>
    open?: string[]
    current?: AppSettings | undefined
  } = {}
) {
  const aliases = options.aliases ?? { powerful: [GPT, GPT_BACKUP], fast: [MINI] }
  const requests: RoutingRequest[] = []
  let ids = 0
  const settings = normalizeRouterFusionSettings({ ...options.settings })
  const host: ChatRouteHost = {
    settings,
    engineDeps: {
      getCapabilities: () => ({ tools: true, vision: true }),
      getContextWindow: () => 200_000,
      isLocalProvider: (id) => id === "ollama",
      getCircuitBreakerState: () => "closed",
      getDeploymentCircuitBreakerState: (key) => (options.open?.includes(key) ? "open" : "closed"),
      isProviderAvailable: () => true,
    },
    planRoute: async (request) => {
      requests.push(request)
      const selection = request.selection
      if (selection.kind === "manual") {
        const known = Object.keys(PRICES).includes(`${selection.providerId}::${selection.modelId}`)
        if (!known) throw new RoutingNoCandidatesError(selection.modelId)
        return planFor([{ providerId: selection.providerId, modelId: selection.modelId }], request)
      }
      if (selection.kind === "alias") {
        const refs = aliases[selection.alias]
        if (!refs?.length) throw new RoutingNoCandidatesError(selection.alias)
        return planFor(refs, request)
      }
      throw new Error("the fusion router never asks the engine for auto")
    },
    pricingOf: (providerId, modelId) => PRICES[`${providerId}::${modelId}`] ?? null,
    subscriptionCapable: (providerId) => providerId === "anthropic",
    isAggregator: (providerId) => providerId === "openrouter",
    currentSettings: () =>
      "current" in options
        ? options.current
        : ({
            routerFusion: {
              ...settings,
              enabled: true,
              surfaces: { ...settings.surfaces, chat: true },
            },
          } as AppSettings),
    environment: "production",
    now: () => Date.UTC(2026, 8, 16),
    newId: () => `id-${++ids}`,
  }
  return { host, requests }
}

function selectionInput(overrides: Partial<ChatSelectionInput> = {}): ChatSelectionInput {
  return {
    selection: { kind: "auto" },
    routingRequest: { surface: "chat", selection: { kind: "auto" } },
    promptText: "What is the capital of France?",
    estimatedInputTokens: 1_000,
    hints: {},
    workspaceId: null,
    hasImages: false,
    needsTools: false,
    ...overrides,
  }
}

async function selected(host: ChatRouteHost, input: ChatSelectionInput) {
  const outcome = await selectChatDeployment(host, input)
  if (outcome.kind !== "selected") throw new Error(`refused: ${outcome.reasons.join(", ")}`)
  return outcome
}

describe("selectChatDeployment", () => {
  it("resolves a manual pick through the engine without the soft cap", async () => {
    const { host, requests } = makeHost()
    const outcome = await selected(host, selectionInput({ selection: { kind: "manual", ...GPT } }))
    expect(outcome).toMatchObject({
      ...GPT,
      actionId: "direct_baseline",
      ruleId: "R1_explicit_action",
    })
    expect(requests[0].maxCostPerRequestUsd).toBe(Number.POSITIVE_INFINITY)
    expect(outcome.plan.costCap).toBeUndefined()
  })

  it("[ACC:ROUTE-08] refuses a pick with no candidate instead of falling back", async () => {
    const { host } = makeHost()
    const outcome = await selectChatDeployment(
      host,
      selectionInput({ selection: { kind: "manual", providerId: "openai", modelId: "retired" } })
    )
    expect(outcome).toEqual({
      kind: "refused",
      code: "ROUTE_NO_SOLUTION",
      reasons: ["NO_CANDIDATES:openai::retired"],
      decision: null,
    })
  })

  it("routes Auto to the baseline action when no rule row is approved (D11)", async () => {
    const { host } = makeHost()
    const outcome = await selected(
      host,
      selectionInput({ promptText: "Translate this to French: hello" })
    )
    expect(outcome).toMatchObject({ ...GPT, actionId: "direct_baseline", ruleId: "R6_baseline" })
    expect(outcome.aliasRefs).toEqual({ powerful: [GPT, GPT_BACKUP], fast: [MINI] })
  })

  it("routes Auto to the economy action once the user approved that rule row", async () => {
    const { host } = makeHost({ settings: { approvedRuleRows: ["economy_simple"] } })
    const outcome = await selected(
      host,
      selectionInput({ promptText: "Translate this to French: hello" })
    )
    expect(outcome).toMatchObject({
      ...MINI,
      actionId: "direct_economy",
      ruleId: "R2_economy_simple",
    })
  })

  it("skips an unavailable deployment and reports the plan for the one chosen", async () => {
    const { host } = makeHost({ open: ["openai::gpt-5"] })
    const outcome = await selected(host, selectionInput())
    expect(outcome).toMatchObject(GPT_BACKUP)
    expect(outcome.plan.selected).toMatchObject(GPT_BACKUP)
    expect(outcome.plan.orderedCandidates.map((c) => c.providerId)).toEqual(["azure", "openai"])
  })

  it("[ACC:ROUTE-06] refuses Auto with the reasons when no direct action can run", async () => {
    const { host } = makeHost({ aliases: { fast: [MINI] } })
    const outcome = await selectChatDeployment(host, selectionInput())
    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused") return
    expect(outcome.reasons).toEqual([
      "NO_CANDIDATES:alias:powerful",
      "direct_baseline:alias_missing:powerful",
      "direct_economy:RULE_NOT_MATCHED",
    ])
    expect(outcome.decision?.selected_action_id).toBeNull()
  })

  it("does not require a tool-capable model for a turn without tools", async () => {
    const { host } = makeHost()
    const outcome = await selected(
      host,
      selectionInput({ promptText: "Fix the failing test in auth.ts" })
    )
    expect(outcome.features.tool_need).toBe("none")
    const withTools = await selected(
      host,
      selectionInput({ promptText: "Fix the failing test in auth.ts", needsTools: true })
    )
    expect(withTools.features.tool_need).not.toBe("none")
  })
})

describe("sealChatRoute", () => {
  it("stamps a metered AI SDK turn: per-call ledger, run cap, pinned output bound", async () => {
    const { host } = makeHost()
    const selection = await selected(host, selectionInput())
    const seal = sealChatRoute(host, {
      selection,
      ...GPT,
      lane: "ai-sdk",
      env: { OPENAI_API_KEY: "sk" },
      sessionId: "session-1",
      maxOutputTokens: undefined,
      existingMaxBudgetUsd: undefined,
    })
    expect(seal.kind).toBe("stamped")
    if (seal.kind !== "stamped") return
    expect(seal.stamp).toMatchObject({
      actionId: "direct_baseline",
      ruleId: "R6_baseline",
      deploymentId: "openai::gpt-5",
      capMicrousd: 500_000,
      priceKnown: true,
      acceptanceProfile: "text_basic",
      lane: "ai-sdk",
      budgetMode: "tracked",
    })
    // 1,000 input tokens at the highest input tier (1h cache write, $2/M) + 8,192 output at $2/M.
    expect(seal.stamp.reserveEstimateMicrousd).toBe(2_000 + 16_384)
    expect(seal.ledger).toEqual({
      runId: seal.stamp.runId,
      mode: "per_call",
      transportAttempts: 2,
      deploymentId: "openai::gpt-5",
    })
    expect(seal.maxOutputTokens).toBe(8192)
    expect(seal.decision.reason_codes).toEqual(
      expect.arrayContaining(["selection:auto", "selected_by:R6_baseline", "billing:metered"])
    )
    expect(seal.prepared).toMatchObject({
      sessionId: "session-1",
      maxModelCalls: 256,
      deadlineMs: 3_600_000,
    })
  })

  it("prices a subscription credential at zero and envelopes the Agent SDK turn", async () => {
    const { host } = makeHost()
    const selection = await selected(
      host,
      selectionInput({ selection: { kind: "manual", ...CLAUDE } })
    )
    const seal = sealChatRoute(host, {
      selection,
      ...CLAUDE,
      lane: "claude-agent-sdk",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oat" },
      sessionId: "session-1",
      maxOutputTokens: 4_000,
      existingMaxBudgetUsd: 0.2,
    })
    expect(seal.kind).toBe("stamped")
    if (seal.kind !== "stamped") return
    expect(seal.stamp.reserveEstimateMicrousd).toBe(0)
    expect(seal.ledger).toMatchObject({ mode: "envelope", envelopeMaxBudgetUsd: 0.2 })
    expect(seal.maxOutputTokens).toBe(4_000)
    expect(seal.decision.reason_codes).toContain("billing:subscription")
  })

  it("prices the same Agent SDK model from its API key when the account is metered", async () => {
    const { host } = makeHost()
    const selection = await selected(
      host,
      selectionInput({ selection: { kind: "manual", ...CLAUDE } })
    )
    const seal = sealChatRoute(host, {
      selection,
      ...CLAUDE,
      lane: "claude-agent-sdk",
      // A gateway ticket blanks the OAuth token: that is a metered key.
      env: { ANTHROPIC_API_KEY: "ticket", CLAUDE_CODE_OAUTH_TOKEN: "" },
      sessionId: "session-1",
      maxOutputTokens: 4_000,
      existingMaxBudgetUsd: undefined,
    })
    expect(seal.kind).toBe("stamped")
    if (seal.kind !== "stamped") return
    expect(seal.stamp.reserveEstimateMicrousd).toBeGreaterThan(0)
    expect(seal.ledger.envelopeMaxBudgetUsd).toBe(0.5)
  })

  it("[ACC:ROUTE-08] refuses a deployment whose reserve exceeds the run cap", async () => {
    const { host } = makeHost()
    const selection = await selected(
      host,
      selectionInput({ selection: { kind: "manual", ...PRICEY } })
    )
    const seal = sealChatRoute(host, {
      selection,
      ...PRICEY,
      lane: "ai-sdk",
      env: {},
      sessionId: "session-1",
      maxOutputTokens: undefined,
      existingMaxBudgetUsd: undefined,
    })
    expect(seal.kind).toBe("refused")
    if (seal.kind !== "refused") return
    expect(seal.reasons).toContain("direct_baseline:BUDGET_EXCEEDS_RUN_AVAILABLE")
  })

  it("refuses an unpriced deployment under a strict budget", async () => {
    const { host } = makeHost({ settings: { budgetMode: "strict" } })
    const unpriced = { providerId: "openai", modelId: "gpt-5" }
    const selection = await selected(
      host,
      selectionInput({ selection: { kind: "manual", ...unpriced } })
    )
    host.pricingOf = () => null
    const seal = sealChatRoute(host, {
      selection,
      ...unpriced,
      lane: "ai-sdk",
      env: {},
      sessionId: "session-1",
      maxOutputTokens: undefined,
      existingMaxBudgetUsd: undefined,
    })
    expect(seal.kind).toBe("refused")
    if (seal.kind !== "refused") return
    expect(seal.reasons.some((r) => r.includes("PRICE_NOT_AUDITED"))).toBe(true)
  })

  it("routes for the model a late plugin patch switched to", async () => {
    const { host } = makeHost()
    const selection = await selected(host, selectionInput())
    const seal = sealChatRoute(host, {
      selection,
      ...MINI,
      lane: "ai-sdk",
      env: {},
      sessionId: "session-1",
      maxOutputTokens: undefined,
      existingMaxBudgetUsd: undefined,
    })
    expect(seal.kind === "stamped" && seal.stamp.deploymentId).toBe("openai::gpt-5-mini")
  })
})

describe("route helpers", () => {
  it("[ACC:AUTH-07] refuses at reservation time what settings no longer allow", () => {
    const { host } = makeHost()
    expect(liveRefusalFor(host, "openai::gpt-5", "internal")).toBeNull()
    expect(liveRefusalFor(host, "openai::gpt-5", "restricted")).toBe("RESTRICTED_NOT_GRANTED")
    expect(liveRefusalFor(host, "ollama::llama", "restricted")).toBeNull()
    expect(liveRefusalFor(host, "garbage", "internal")).toBe("DEPLOYMENT_UNKNOWN")
    host.engineDeps.isProviderAvailable = (id) => id !== "openai"
    expect(liveRefusalFor(host, "openai::gpt-5", "internal")).toBe("PROVIDER_UNAVAILABLE")
    const off = makeHost({ current: {} as AppSettings }).host
    expect(liveRefusalFor(off, "openai::gpt-5", "internal")).toBe("ROUTER_FUSION_DISABLED")
  })

  it("lets a workspace raise the data class but never lower it", () => {
    const settings = normalizeRouterFusionSettings({
      defaultDataClass: "internal",
      dataClassByWorkspaceId: { secret: "restricted", open: "public" },
    })
    expect(dataClassFor(settings, "secret")).toBe("restricted")
    expect(dataClassFor(settings, "open")).toBe("internal")
    expect(dataClassFor(DEFAULT_ROUTER_FUSION_SETTINGS, null)).toBe("internal")
  })

  it("never pauses a chat turn for missing information", () => {
    expect(chatFeatures("", {}).missing_information).toEqual([])
    expect(chatFeatures("", {}).task).toBe("unknown")
  })

  it("reads a subscription only from a non-empty OAuth credential", () => {
    expect(isSubscriptionEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oat" })).toBe(true)
    expect(isSubscriptionEnv({ CODEX_ACCESS_TOKEN: "ct" })).toBe(true)
    expect(isSubscriptionEnv({ CLAUDE_CODE_OAUTH_TOKEN: "" })).toBe(false)
    expect(isSubscriptionEnv(undefined)).toBe(false)
  })
})
