import { RoutingNoCandidatesError } from "@cognia/provider-routing"
import type { RoutingPlan, RoutingRequest } from "@cognia/provider-types/auto-router"
import type { ModelPricing } from "@cognia/provider-types/provider"
import {
  CONTRACT_SCHEMA_VERSION,
  RouteDecisionSchema,
  type ExecutionMode,
  type RunRequest,
} from "@cognia/router-fusion"
import {
  normalizeRouterFusionSettings,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"

import type { ChatRouteHost } from "../chat/route-chat-turn"
import { routeRunRequest, runFeatures, runVerifierProfiles, type RunRouteInput } from "./run-route"

type Ref = { providerId: string; modelId: string }
const MINI: Ref = { providerId: "openai", modelId: "gpt-5-mini" }
const GPT: Ref = { providerId: "openai", modelId: "gpt-5" }
const SONNET: Ref = { providerId: "anthropic", modelId: "claude-sonnet-5" }

const PRICES: Record<string, Partial<ModelPricing>> = {
  "openai::gpt-5-mini": { promptPer1M: 0.1, completionPer1M: 0.4 },
  "openai::gpt-5": { promptPer1M: 1, completionPer1M: 2 },
  "anthropic::claude-sonnet-5": { promptPer1M: 3, completionPer1M: 15 },
}

const EXECUTABLE: ExecutionMode[] = ["direct", "cascade", "panel"]

function planFor(refs: Ref[], request: RoutingRequest): RoutingPlan {
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
}

function makeHost(
  options: { settings?: Partial<RouterFusionSettings>; aliases?: Record<string, Ref[]> } = {}
) {
  const aliases = options.aliases ?? { fast: [MINI], powerful: [GPT], balanced: [SONNET] }
  const requests: RoutingRequest[] = []
  let ids = 0
  const host: ChatRouteHost = {
    settings: normalizeRouterFusionSettings({ enabled: true, ...options.settings }),
    engineDeps: {
      getCapabilities: () => ({ tools: true, structuredOutput: true, vision: false }),
      getContextWindow: () => 200_000,
      isLocalProvider: () => false,
      getCircuitBreakerState: () => "closed",
      getDeploymentCircuitBreakerState: () => "closed",
      isProviderAvailable: () => true,
    },
    planRoute: async (request) => {
      requests.push(request)
      const alias = request.selection.kind === "alias" ? request.selection.alias : ""
      const refs = aliases[alias]
      if (!refs || refs.length === 0) throw new RoutingNoCandidatesError(`no ${alias}`)
      return planFor(refs, request)
    },
    pricingOf: (providerId, modelId) => PRICES[`${providerId}::${modelId}`] ?? null,
    subscriptionCapable: () => true,
    isAggregator: () => false,
    currentSettings: () => undefined,
    environment: "test",
    now: () => 1_800_000_000_000,
    newId: () => `id-${++ids}`,
  }
  return { host, requests }
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    input_messages: [{ role: "user", content: "Compare the 2024 and 2025 steel tariffs." }],
    mode: "panel",
    allowed_modes: ["panel"],
    profile: "balanced",
    budget: { max_cost_usd: "2.000000", mode: "tracked" },
    deadline_ms: 120_000,
    allow_degraded: false,
    delivery: "verified_buffered",
    ...overrides,
  } as RunRequest
}

function input(overrides: Partial<RunRouteInput> = {}): RunRouteInput {
  const req = overrides.request ?? request()
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    decisionId: "22222222-2222-4222-8222-222222222222",
    request: req,
    messages: req.input_messages.map((m) => ({ role: "user" as const, content: m.content })),
    jsonSchema: null,
    sessionId: "session-1",
    webToolsAvailable: true,
    executableModes: EXECUTABLE,
    ...overrides,
  }
}

describe("routeRunRequest", () => {
  it("routes an explicit panel to independent members, a judge and a synthesizer", async () => {
    const { host, requests } = makeHost()
    const route = await routeRunRequest(host, input())
    expect(route.kind).toBe("selected")
    if (route.kind !== "selected") return
    expect(route).toMatchObject({
      actionId: "panel_review",
      mode: "panel",
      ruleId: "R1_explicit_mode",
      acceptanceProfile: "evidence_review",
      task: "research.synthesis",
      dataClass: "internal",
      roles: {
        panel_a: "openai::gpt-5-mini",
        panel_b: "anthropic::claude-sonnet-5",
        judge: "openai::gpt-5",
        synthesizer: "openai::gpt-5",
      },
    })
    expect(RouteDecisionSchema.parse(route.decision)).toEqual(route.decision)
    expect(route.decision.reason_codes).toEqual(
      expect.arrayContaining(["entry:run_api", "billing:metered"])
    )
    // Every alias a panel action names was resolved, with no soft cap.
    expect(requests.map((r) => (r.selection as { alias: string }).alias).sort()).toEqual([
      "balanced",
      "fast",
      "powerful",
    ])
    expect(
      requests.every(
        (r) => r.surface === "gateway" && r.maxCostPerRequestUsd === Number.POSITIVE_INFINITY
      )
    ).toBe(true)
  })

  it("describes every deployment as the metered lane this host executes", async () => {
    const { host } = makeHost()
    const route = await routeRunRequest(host, input())
    if (route.kind !== "selected") throw new Error("refused")
    const anthropic = route.config.deploymentsById["anthropic::claude-sonnet-5"]
    // A subscription-capable provider is still metered here: the run uses API keys.
    expect(anthropic).toMatchObject({ billingTransparency: "bounded", internalRetry: "none" })
    expect(anthropic.rateCardId).not.toBe("rc:audited-zero")
  })

  it("[ACC:ROUTE-08] refuses a panel whose members would be the same model, rather than pretending", async () => {
    const { host } = makeHost({ aliases: { fast: [GPT], powerful: [GPT], balanced: [GPT] } })
    const route = await routeRunRequest(host, input())
    expect(route).toMatchObject({ kind: "refused", code: "ROUTE_NO_SOLUTION" })
    if (route.kind === "refused")
      expect(route.reasons).toContain("panel_review:PANEL_SAME_REVISION")
  })

  it("offers a schema check only when the caller asked for structured output", async () => {
    const cascade = request({ mode: "cascade", allowed_modes: ["cascade"] })
    const { host } = makeHost()
    // Without a schema, the review cascade checks the draft with a model.
    const without = await routeRunRequest(host, input({ request: cascade }))
    expect(without).toMatchObject({
      kind: "selected",
      actionId: "cascade_review",
      acceptanceProfile: "text_review",
    })
    if (without.kind === "selected") {
      const excluded = without.decision.candidates
        .filter((candidate) => !candidate.eligible)
        .flatMap((candidate) =>
          candidate.exclusion_reasons.map((reason) => `${candidate.action_id}:${reason}`)
        )
      expect(excluded).toEqual(
        expect.arrayContaining([
          "cascade_schema:VERIFIER_UNAVAILABLE",
          "cascade_code:VERIFIER_UNAVAILABLE",
        ])
      )
    }
    // With the review cascade switched off, nothing else can check plain text.
    const noReview = makeHost({
      settings: { actionOverrides: { cascade_review: { enabled: false } } },
    })
    await expect(
      routeRunRequest(noReview.host, input({ request: cascade }))
    ).resolves.toMatchObject({
      kind: "refused",
      code: "ROUTE_NO_SOLUTION",
    })
    const withSchema = await routeRunRequest(
      host,
      input({ request: cascade, jsonSchema: { type: "object" } })
    )
    expect(withSchema).toMatchObject({
      kind: "selected",
      actionId: "cascade_schema",
      acceptanceProfile: "schema_fixture",
      roles: { cheap: "openai::gpt-5-mini", strong: "openai::gpt-5" },
    })
  })

  it("[ACC:ROUTE-02] picks only the baseline for auto until the user approves a rule row", async () => {
    const auto = request({ mode: "auto", allowed_modes: ["direct", "cascade", "panel"] })
    const baseline = await routeRunRequest(makeHost().host, input({ request: auto }))
    expect(baseline).toMatchObject({
      kind: "selected",
      actionId: "direct_baseline",
      ruleId: "R6_baseline",
    })

    const approved = makeHost({ settings: { approvedRuleRows: ["panel_research"] } })
    const research = await routeRunRequest(approved.host, input({ request: auto }))
    expect(research).toMatchObject({
      kind: "selected",
      actionId: "panel_review",
      ruleId: "R4_panel_research",
    })
  })

  it("never assesses a mode this build does not execute", async () => {
    const { host } = makeHost()
    const route = await routeRunRequest(
      host,
      input({ request: request({ mode: "auto", allowed_modes: ["delegate", "direct"] }) })
    )
    expect(route).toMatchObject({ kind: "selected", mode: "direct" })
    if (route.kind === "selected") {
      const delegate = route.decision.candidates.find((c) => c.action_id === "delegate_code")
      expect(delegate?.eligible).toBe(false)
      expect(delegate?.exclusion_reasons).toContain("MODE_NOT_ALLOWED")
    }
  })

  it("names an alias nothing can serve among its reasons", async () => {
    const { host } = makeHost({ aliases: { fast: [MINI], powerful: [GPT] } })
    const route = await routeRunRequest(host, input())
    expect(route.kind).toBe("refused")
    if (route.kind === "refused") {
      expect(route.reasons).toEqual(
        expect.arrayContaining([
          "NO_CANDIDATES:alias:balanced",
          "panel_review:alias_missing:balanced",
        ])
      )
    }
  })

  it("[ACC:BUD-08] lets the request lower the action's cap and deadline, never raise them", async () => {
    const { host } = makeHost()
    // The panel's own estimate already fills its 120 s action deadline, so the lowering is shown on a direct run.
    const low = await routeRunRequest(
      host,
      input({
        request: request({
          mode: "direct",
          allowed_modes: ["direct"],
          budget: { max_cost_usd: "0.300000", mode: "tracked" },
          deadline_ms: 60_000,
        }),
      })
    )
    if (low.kind === "refused") throw new Error(`refused: ${low.reasons.join(", ")}`)
    expect(low).toMatchObject({
      kind: "selected",
      mode: "direct",
      capMicrousd: 300_000,
      deadlineMs: 60_000,
    })

    // A deadline shorter than the panel's own estimate is a refusal, not a gamble.
    const rushed = await routeRunRequest(host, input({ request: request({ deadline_ms: 30_000 }) }))
    expect(rushed.kind).toBe("refused")
    if (rushed.kind === "refused")
      expect(rushed.reasons).toContain("panel_review:DEADLINE_EXCEEDED")

    const high = await routeRunRequest(
      makeHost({
        settings: { runCapUsdByMode: { direct: "0.5", cascade: "1", panel: "3", delegate: "5" } },
      }).host,
      input({
        request: request({
          budget: { max_cost_usd: "9.000000", mode: "tracked" },
          deadline_ms: 3_600_000,
        }),
      })
    )
    // The request's 9 USD is not the budget: the route already refuses more than the run may spend.
    expect(high.kind).toBe("selected")
    if (high.kind === "selected") {
      expect(high.capMicrousd).toBe(3_000_000)
      expect(high.deadlineMs).toBe(120_000)
    }
  })

  it("excludes unpriced deployments under a strict budget", async () => {
    const { host } = makeHost({
      aliases: {
        fast: [{ providerId: "x", modelId: "unpriced" }],
        powerful: [GPT],
        balanced: [SONNET],
      },
    })
    const route = await routeRunRequest(
      host,
      input({ request: request({ budget: { max_cost_usd: "2.000000", mode: "strict" } }) })
    )
    expect(route.kind).toBe("refused")
  })

  it("asks members for tools only when this host can run them", async () => {
    const { host } = makeHost()
    const route = await routeRunRequest(host, input({ webToolsAvailable: false }))
    expect(route).toMatchObject({ kind: "selected", actionId: "panel_review" })
  })
})

describe("runFeatures", () => {
  it("labels the caller's text, keeps its system turns as constraints and never pauses for input", () => {
    const features = runFeatures(
      [
        { role: "system", content: "Answer in JSON." },
        { role: "user", content: "Compare Postgres and MySQL for this workload." },
      ],
      { type: "object" }
    )
    expect(features).toMatchObject({
      task: "research.synthesis",
      verification_kinds: ["json_schema"],
      missing_information: [],
      phase: "intake",
    })
    expect(runFeatures([{ role: "user", content: "hi" }], null).verification_kinds).toEqual([])
  })
})

describe("runVerifierProfiles", () => {
  it("never claims a code fixture, and a schema check only with a schema", () => {
    expect(runVerifierProfiles(null)).toEqual(["text_basic", "text_review", "evidence_review"])
    expect(runVerifierProfiles({})).toContain("schema_fixture")
    expect(runVerifierProfiles({})).not.toContain("code_fixture")
  })
})
