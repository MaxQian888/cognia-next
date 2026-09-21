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

import type { AppSettings } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"

import type { ChatRouteHost } from "../chat/route-chat-turn"
import type { BeginLedgeredUtilityCallInput } from "../gate/utility-ledger"
import { createRouteClassifier } from "./llm-classifier"
import {
  routeRunRequest,
  runFeatures,
  runFeaturesFrom,
  runSnapshot,
  runVerifierProfiles,
  type RunRouteInput,
} from "./run-route"

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

describe("runSnapshot and runFeaturesFrom", () => {
  it("give the rules path exactly what runFeatures always gave", () => {
    const messages = [
      { role: "system" as const, content: "Answer in JSON." },
      { role: "user" as const, content: "Compare Postgres and MySQL for this workload." },
    ]
    const snapshot = runSnapshot(messages, { type: "object" })
    expect(snapshot).toMatchObject({
      userText: "Compare Postgres and MySQL for this workload.",
      trustedConstraints: ["Answer in JSON."],
      verificationKinds: ["json_schema"],
      phase: "intake",
    })
    const features = runFeatures(messages, { type: "object" })
    expect(
      runFeaturesFrom(snapshot, {
        labels: {
          task: features.task,
          ambiguity: features.ambiguity,
          tool_need: features.tool_need,
          scope: features.scope,
          missing_information: ["something"],
          goal: features.goal,
        },
        input: {
          text: "",
          truncated: false,
          estimatedTokens: 0,
          routingContext: "",
          userText: "",
        },
      })
    ).toEqual(features)
  })
})

// ── the opt-in LLM classifier (D18, B5) at the Run API entry point ────────────

let classifierAccounts = 0

/** The real classifier, its ledger and router model faked at the seams. */
function classifierFor(
  reply: (prompt: string, options?: { abortSignal?: AbortSignal }) => Promise<string>,
  classifier: Record<string, unknown> = {}
) {
  const begins: BeginLedgeredUtilityCallInput[] = []
  const handle = {
    runId: "classifier-run",
    maxOutputTokens: 256,
    succeeded: jest.fn(async () => undefined),
    failed: jest.fn(async () => undefined),
    unknown: jest.fn(async () => undefined),
  }
  const complete = jest.fn(reply)
  const account = `run-account-${++classifierAccounts}`
  const classify = createRouteClassifier(
    {
      routerFusion: {
        enabled: true,
        surfaces: { gatewayRuns: true, chat: true },
        llmClassifier: {
          enabled: true,
          routerProviderId: "openai",
          routerModelId: "gpt-5-mini",
          ...classifier,
        },
      },
    } as unknown as AppSettings,
    {
      begin: async (call) => {
        begins.push(call)
        return { kind: "granted", handle }
      },
      buildClient: async () => ({ complete }) as unknown as LlmClient,
      accountKey: async () => account,
    }
  )
  if (!classify) throw new Error("the classifier should be on")
  return { classify, begins, handle, complete }
}

const RESEARCH = JSON.stringify({
  task: "research.synthesis",
  ambiguity: "low",
  tool_need: "read_only",
  scope: "single_item",
  missing_information: [],
  goal: "Explain how the tariffs differ",
})

describe("routeRunRequest with the LLM classifier (D18)", () => {
  const question = request({
    mode: "auto",
    allowed_modes: ["direct", "cascade", "panel"],
    input_messages: [{ role: "user", content: "Why does the 2025 steel tariff differ from 2024?" }],
  })

  it("routes an auto request by the model's labels, booked on the Run API's surface", async () => {
    // By the rules this is a knowledge question, so Auto keeps the baseline.
    const rulesOnly = makeHost({ settings: { approvedRuleRows: ["panel_research"] } })
    expect(await routeRunRequest(rulesOnly.host, input({ request: question }))).toMatchObject({
      kind: "selected",
      actionId: "direct_baseline",
    })

    const { host } = makeHost({ settings: { approvedRuleRows: ["panel_research"] } })
    const { classify, begins, handle } = classifierFor(async () => RESEARCH)
    host.classify = classify
    const route = await routeRunRequest(host, input({ request: question }))
    if (route.kind !== "selected") throw new Error(`refused: ${route.reasons.join(", ")}`)
    expect(route).toMatchObject({
      actionId: "panel_review",
      ruleId: "R4_panel_research",
      task: "research.synthesis",
    })
    expect(route.decision.classifier_version).toBe("classifier-1")
    expect(route.decision.reason_codes).toEqual(
      expect.arrayContaining(["classifier:classifier-1", "classifier_source:llm", "entry:run_api"])
    )
    expect(RouteDecisionSchema.parse(route.decision)).toEqual(route.decision)
    expect(begins).toEqual([
      expect.objectContaining({ surface: "gatewayRuns", origin: "utility", workspaceId: null }),
    ])
    expect(handle.succeeded).toHaveBeenCalledTimes(1)
  })

  it("books a chat fusion turn's classification on the chat surface", async () => {
    const { host } = makeHost({ settings: { approvedRuleRows: ["panel_research"] } })
    const { classify, begins } = classifierFor(async () => RESEARCH)
    host.classify = classify
    host.surface = "chat"
    await routeRunRequest(host, input({ request: question, workspaceId: "project-1" }))
    expect(begins[0]).toMatchObject({ surface: "chat", workspaceId: "project-1" })
  })

  it("[ACC:ROUTE-03] routes a timed-out classification by the rules within the bound, keeping the call's cost", async () => {
    const { host } = makeHost({ settings: { approvedRuleRows: ["panel_research"] } })
    const { classify, handle } = classifierFor(
      (_prompt, options) =>
        new Promise<string>((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          )
        }),
      { timeoutMs: 25 }
    )
    host.classify = classify
    const started = Date.now()
    const route = await routeRunRequest(host, input({ request: question }))
    expect(Date.now() - started).toBeLessThan(1_000)
    if (route.kind !== "selected") throw new Error("refused")
    expect(route).toMatchObject({ actionId: "direct_baseline", ruleId: "R6_baseline" })
    expect(route.decision.classifier_version).toBe("rules-1")
    expect(route.decision.reason_codes).toEqual(
      expect.arrayContaining(["classifier_source:rules_fallback", "classifier_fallback:timeout"])
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handle.unknown).toHaveBeenCalledWith("aborted_before_answer")
  })

  it("[ACC:ROUTE-03] routes by the rules on invalid JSON, with the paid call settled", async () => {
    const { host } = makeHost({ settings: { approvedRuleRows: ["panel_research"] } })
    const { classify, handle } = classifierFor(async () => "research, probably")
    host.classify = classify
    const route = await routeRunRequest(host, input({ request: question }))
    if (route.kind !== "selected") throw new Error("refused")
    expect(route.actionId).toBe("direct_baseline")
    expect(route.decision.reason_codes).toEqual(
      expect.arrayContaining([
        "classifier_source:rules_fallback",
        "classifier_fallback:invalid_json",
      ])
    )
    expect(handle.succeeded).toHaveBeenCalledTimes(1)
  })

  it("records the classification on a refusal", async () => {
    const { host } = makeHost()
    host.classify = classifierFor(async () => RESEARCH).classify
    // A budget nothing fits under: every action is excluded.
    const broke = { ...question, budget: { max_cost_usd: "0.000001", mode: "tracked" as const } }
    const route = await routeRunRequest(host, input({ request: broke }))
    expect(route.kind).toBe("refused")
    if (route.kind === "refused")
      expect(route.decision?.reason_codes).toContain("classifier_source:llm")
  })

  it("never classifies an explicit mode with a model", async () => {
    const { host } = makeHost()
    const { classify, complete } = classifierFor(async () => RESEARCH)
    host.classify = classify
    const route = await routeRunRequest(host, input())
    if (route.kind !== "selected") throw new Error("refused")
    expect(complete).not.toHaveBeenCalled()
    expect(route.decision.classifier_version).toBe("rules-1")
    expect(route.decision.reason_codes.some((code) => code.startsWith("classifier_source"))).toBe(
      false
    )
  })
})

describe("runVerifierProfiles", () => {
  it("claims a schema check only with a schema, and a code fixture only with both halves", () => {
    expect(runVerifierProfiles(null)).toEqual(["text_basic", "text_review", "evidence_review"])
    expect(runVerifierProfiles({})).toContain("schema_fixture")
    // A code fixture needs a sandbox AND an approved command; one alone is not
    // a verifier, and offering it would let the router pick what it cannot accept.
    expect(runVerifierProfiles({})).not.toContain("code_fixture")
    expect(
      runVerifierProfiles(null, { sandboxTier: "os", acceptanceProfileAvailable: false })
    ).not.toContain("code_fixture")
    expect(
      runVerifierProfiles(null, { sandboxTier: null, acceptanceProfileAvailable: true })
    ).not.toContain("code_fixture")
    expect(
      runVerifierProfiles(null, { sandboxTier: "os", acceptanceProfileAvailable: true })
    ).toContain("code_fixture")
  })
})

// ── delegate (WP-D4) ──────────────────────────────────────────────────────────

const WITH_DELEGATE: ExecutionMode[] = ["direct", "cascade", "panel", "delegate"]
const PROJECT = "99999999-9999-4999-8999-999999999999"

function delegateRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return request({
    mode: "delegate",
    allowed_modes: ["delegate"],
    input_messages: [{ role: "user", content: "Fix the pagination race across the users module." }],
    workspace_id: PROJECT,
    acceptance_profile_id: "unit",
    budget: { max_cost_usd: "5.000000", mode: "tracked" },
    deadline_ms: 900_000,
    ...overrides,
  } as Partial<RunRequest>)
}

function delegateInput(
  capabilities: {
    sandboxTier?: "microvm" | "container" | "os" | null
    available?: boolean
    approved?: string[]
    reason?: string | null
  } = {},
  overrides: Partial<RunRouteInput> = {}
): RunRouteInput {
  return input({
    request: delegateRequest(),
    executableModes: WITH_DELEGATE,
    delegateCapabilities: {
      sandboxTier: async () => ("sandboxTier" in capabilities ? capabilities.sandboxTier! : "os"),
      acceptanceProfiles: async () => ({
        available: capabilities.available ?? true,
        approvedProfileIds: capabilities.approved ?? ["unit"],
        reason: capabilities.reason ?? null,
      }),
    },
    ...overrides,
  })
}

describe("routeRunRequest for delegate", () => {
  it("routes to the delegate action and carries the project, its checkout and the profile", async () => {
    const { host } = makeHost()
    const route = await routeRunRequest(host, delegateInput())
    expect(route.kind).toBe("selected")
    if (route.kind !== "selected") return
    expect(route.mode).toBe("delegate")
    expect(route.actionId).toBe("delegate_code")
    expect(route.acceptanceProfile).toBe("code_fixture")
    expect(route.roles).toMatchObject({ lead: expect.any(String), worker: expect.any(String) })
    expect(route.projectId).toBe(PROJECT)
    expect(route.acceptanceProfileId).toBe("unit")
  })

  it("refuses with SANDBOX_UNAVAILABLE when nothing here can confine generated code", async () => {
    const { host } = makeHost()
    const route = await routeRunRequest(host, delegateInput({ sandboxTier: null }))
    expect(route.kind).toBe("refused")
    if (route.kind !== "refused") return
    expect(route.reasons).toEqual(
      expect.arrayContaining(["delegate_code:SANDBOX_UNAVAILABLE", "delegate:no_sandbox_tier"])
    )
  })

  it("refuses with ACCEPTANCE_PROFILE_MISSING when the project's command is not approved", async () => {
    const { host } = makeHost()
    const route = await routeRunRequest(
      host,
      delegateInput({ available: false, approved: [], reason: "approval_pending" })
    )
    expect(route.kind).toBe("refused")
    if (route.kind !== "refused") return
    expect(route.reasons).toEqual(
      expect.arrayContaining([
        "delegate_code:ACCEPTANCE_PROFILE_MISSING",
        "delegate:approval_pending",
      ])
    )
  })

  it("never probes the device for a request that cannot reach delegate", async () => {
    const { host } = makeHost()
    const sandboxTier = jest.fn(async () => "os" as const)
    const route = await routeRunRequest(host, input({ delegateCapabilities: { sandboxTier } }))
    expect(route.kind).toBe("selected")
    expect(sandboxTier).not.toHaveBeenCalled()
  })

  it("falls back to the project's only approved profile when the request named an unapproved one", async () => {
    const { host } = makeHost()
    const route = await routeRunRequest(
      host,
      delegateInput({ approved: ["e2e"] }, { request: delegateRequest() })
    )
    expect(route.kind).toBe("selected")
    if (route.kind !== "selected") return
    expect(route.acceptanceProfileId).toBe("e2e")
  })

  it("carries no project, checkout or profile on a route that is not delegate", async () => {
    const { host } = makeHost()
    const route = await routeRunRequest(host, input())
    expect(route.kind).toBe("selected")
    if (route.kind !== "selected") return
    expect(route.workspaceRoot).toBeNull()
    expect(route.acceptanceProfileId).toBeNull()
  })
})

describe("routeRunRequest when no alias resolves at all", () => {
  it("refuses with ROUTE_NO_SOLUTION and its reasons, instead of throwing a config error", async () => {
    // Nothing is configured: every alias plan raises `RoutingNoCandidatesError`,
    // so the compiled policy would have zero actions — which the compiler
    // rejects. That used to escape as a 500; the contract calls it 422.
    const { host } = makeHost({ aliases: {} })
    const route = await routeRunRequest(host, input())
    expect(route.kind).toBe("refused")
    if (route.kind !== "refused") return
    expect(route.code).toBe("ROUTE_NO_SOLUTION")
    expect(route.reasons).toEqual(
      expect.arrayContaining([
        "NO_CANDIDATES:alias:fast",
        expect.stringContaining("CONFIG_INVALID:"),
      ])
    )
    expect(route.decision).toBeNull()
  })
})
