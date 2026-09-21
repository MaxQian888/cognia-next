/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { AppSettings } from "@cognia/agent-config-types"
import {
  classifyWithRules,
  intakeSnapshot,
  systemPromptFor,
  type ClassifierOutput,
} from "@cognia/router-fusion"
import type { LlmClient, LlmClientCallOptions, LlmUsageSnapshot } from "@/lib/twin/distill/llm"

// ── the ledger's own dependencies, as `ledgered-llm-client.test.ts` fakes them ─
const engineDeps = {
  getCapabilities: () => ({ tools: true, vision: true }),
  getContextWindow: () => 200_000,
  isLocalProvider: () => false,
  getCircuitBreakerState: () => "closed" as const,
  getDeploymentCircuitBreakerState: () => "closed" as const,
  isProviderAvailable: () => true,
}
jest.mock("@cognia/provider-routing/build-preview-engine", () => ({
  buildRoutingEngineDeps: () => engineDeps,
}))
jest.mock("@cognia/provider-core/providers/model-pricing", () => ({
  resolveModelPricing: (providerId: string, modelId: string) =>
    `${providerId}::${modelId}` === "openai::gpt-5-mini"
      ? { promptPer1M: 0.1, completionPer1M: 0.4 }
      : null,
}))
jest.mock("@cognia/provider-types/provider", () => ({
  ...jest.requireActual("@cognia/provider-types/provider"),
  getAllProviders: () => ({ openai: { category: "cloud" } }),
}))
jest.mock("@/lib/subscription/core/provider-registry", () => ({
  getSubscriptionProvider: () => undefined,
}))

let store: FusionLedgerStore
const storeFault: { error: Error | null } = { error: null }
jest.mock("../chat/store-provider", () => ({
  currentFusionStore: async () => {
    if (storeFault.error) throw storeFault.error
    return store
  },
}))

const settingsState: { settings: AppSettings | null; loaded: boolean } = {
  settings: null,
  loaded: true,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => settingsState },
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: async () => null }))

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import { RouterFusionInfrastructureError, RouterFusionRefusalError } from "../gate/faults"
import {
  __resetClassifierCachesForTesting,
  CLASSIFIER_FEATURE_ID,
  CLASSIFIER_MAX_OUTPUT_TOKENS,
  ClassifierCache,
  classificationReasonCodes,
  classifierCacheFor,
  classifierConfigHash,
  classifyWithLlm,
  createRouteClassifier,
  judgeDifficultyWithClassifier,
  normalizeClassifierText,
  type ClassifierCallOptions,
  type LlmClassifierDeps,
} from "./llm-classifier"

const ANSWER: ClassifierOutput = {
  task: "text.transform",
  ambiguity: "low",
  tool_need: "none",
  scope: "single_item",
  missing_information: [],
  goal: "Rewrite a sentence",
}
const REPLY = JSON.stringify(ANSWER)
const PROMPT = "What is the capital of France?"

function abortError(): Error {
  const error = new Error("The operation was aborted.")
  error.name = "AbortError"
  return error
}

/** A reply that never comes on its own; it rejects when the call is aborted. */
function hang(_prompt: string, options?: { abortSignal?: AbortSignal }): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    options?.abortSignal?.addEventListener("abort", () => reject(abortError()))
  })
}

function deps(
  call: LlmClassifierDeps["call"],
  overrides: Partial<LlmClassifierDeps> = {}
): LlmClassifierDeps {
  return {
    call,
    cache: new ClassifierCache("test-secret"),
    configHash: classifierConfigHash({ providerId: "openai", modelId: "gpt-5-mini" }),
    timeoutMs: 1_500,
    cacheTtlMs: 600_000,
    now: () => 1_000,
    ...overrides,
  }
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

beforeEach(() => {
  __resetClassifierCachesForTesting()
  storeFault.error = null
})

describe("classifyWithLlm", () => {
  it("labels the request with the model's validated answer", async () => {
    const call = jest.fn(async (_prompt: string, _options: ClassifierCallOptions) => REPLY)
    const outcome = await classifyWithLlm(deps(call), intakeSnapshot(PROMPT), {})
    expect(outcome).toMatchObject({
      source: "llm",
      cached: false,
      classifierVersion: "classifier-1",
      labels: { task: "text.transform", ambiguity: "low", scope: "single_item" },
    })
    expect(outcome.fallback).toBeUndefined()
    expect(classificationReasonCodes(outcome)).toEqual(["classifier_source:llm"])
    const [prompt, options] = call.mock.calls[0]
    expect(options).toMatchObject({
      system: systemPromptFor("classifier"),
      maxTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
      temperature: 0,
    })
    expect(options.abortSignal.aborted).toBe(false)
    expect(prompt).toContain(PROMPT)
  })

  it("[ACC:ROUTE-03] ends a classifier timeout within its bound, aborts the call and routes by the rules", async () => {
    let signal: AbortSignal | undefined
    const call = jest.fn((prompt: string, options: ClassifierCallOptions) => {
      signal = options.abortSignal
      return hang(prompt, options)
    })
    const started = Date.now()
    const outcome = await classifyWithLlm(deps(call, { timeoutMs: 30 }), intakeSnapshot(PROMPT), {})
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(signal?.aborted).toBe(true)
    expect(outcome).toMatchObject({
      source: "rules_fallback",
      classifierVersion: "rules-1",
      fallback: { reason: "timeout" },
      labels: classifyWithRules(`phase: intake\nfailed_attempts: 0\n\n${PROMPT}`),
    })
    expect(classificationReasonCodes(outcome)).toEqual([
      "classifier_source:rules_fallback",
      "classifier_fallback:timeout",
    ])
  })

  it("[ACC:ROUTE-03] falls back to the rules on invalid JSON or a reply outside the schema, after the call was made", async () => {
    for (const [reply, reason] of [
      ["Sure, it's a transform.", "invalid_json"],
      [JSON.stringify({ ...ANSWER, p_pass: 0.8 }), "schema_invalid"],
      [JSON.stringify({ ...ANSWER, task: "chit-chat" }), "schema_invalid"],
    ] as const) {
      const call = jest.fn(async () => reply)
      const outcome = await classifyWithLlm(deps(call), intakeSnapshot(PROMPT), {})
      expect(call).toHaveBeenCalledTimes(1)
      expect(outcome).toMatchObject({
        source: "rules_fallback",
        classifierVersion: "rules-1",
        fallback: { reason },
      })
      expect(outcome.labels.task).toBe("qa.knowledge")
    }
  })

  it("never sends a request the PII gate objects to", async () => {
    const call = jest.fn(async () => REPLY)
    const outcome = await classifyWithLlm(
      deps(call),
      intakeSnapshot("Email dana@example.com the card 4111 1111 1111 1111"),
      {}
    )
    expect(call).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ source: "rules_fallback", fallback: { reason: "pii_blocked" } })
  })

  it("classifies nothing when there is nothing to send or nowhere to send it", async () => {
    const call = jest.fn(async () => REPLY)
    expect((await classifyWithLlm(deps(call), intakeSnapshot("   "), {})).fallback).toEqual({
      reason: "empty_request",
    })
    expect(
      (
        await classifyWithLlm(
          deps(null, { unavailable: "model_unset" }),
          intakeSnapshot(PROMPT),
          {}
        )
      ).fallback
    ).toEqual({ reason: "model_unset" })
    const overCap = {
      ...intakeSnapshot(PROMPT),
      trustedConstraints: ["a trusted constraint ".repeat(1_000)],
    }
    expect((await classifyWithLlm(deps(call), overCap, {})).fallback).toEqual({
      reason: "input_over_cap",
    })
    expect(call).not.toHaveBeenCalled()
  })

  it("says why a call failed: a refusal, a ledger fault or the provider", async () => {
    const outcomeOf = (error: Error) =>
      classifyWithLlm(
        deps(async () => {
          throw error
        }),
        intakeSnapshot(PROMPT),
        {}
      )
    expect((await outcomeOf(new RouterFusionRefusalError("BUDGET_FROZEN", "no"))).fallback).toEqual(
      { reason: "refused", code: "BUDGET_FROZEN" }
    )
    const fault = await outcomeOf(new RouterFusionInfrastructureError("db_unavailable", "down"))
    expect(fault.fallback).toEqual({ reason: "infrastructure", code: "db_unavailable" })
    expect(classificationReasonCodes(fault)).toEqual([
      "classifier_source:rules_fallback",
      "classifier_fallback:infrastructure",
      "classifier_fallback_code:db_unavailable",
    ])
    expect((await outcomeOf(new Error("503 upstream"))).fallback).toEqual({
      reason: "provider_error",
    })
  })
})

describe("the classification cache", () => {
  it("answers a repeated request from memory, whatever its spacing", async () => {
    const call = jest.fn(async () => REPLY)
    const shared = deps(call)
    const miss = await classifyWithLlm(shared, intakeSnapshot(PROMPT), {})
    const hit = await classifyWithLlm(
      shared,
      intakeSnapshot(`  What is the   capital of France?\n`),
      {}
    )
    expect(call).toHaveBeenCalledTimes(1)
    expect(miss.cached).toBe(false)
    expect(hit).toMatchObject({ source: "llm", cached: true, labels: miss.labels })
    expect(classificationReasonCodes(hit)).toEqual([
      "classifier_source:llm",
      "classifier_cache:hit",
    ])
    // A different request, or the same one for another classifier configuration, misses.
    await classifyWithLlm(shared, intakeSnapshot("Rewrite this sentence."), {})
    await classifyWithLlm(
      { ...shared, configHash: classifierConfigHash({ providerId: "openai", modelId: "gpt-5" }) },
      intakeSnapshot(PROMPT),
      {}
    )
    expect(call).toHaveBeenCalledTimes(3)
  })

  it("expires an entry after the configured TTL, and caches nothing with a TTL of 0", async () => {
    let now = 1_000
    const call = jest.fn(async () => REPLY)
    const cache = new ClassifierCache("s")
    const withTtl = (cacheTtlMs: number) => deps(call, { cache, cacheTtlMs, now: () => now })
    await classifyWithLlm(withTtl(600_000), intakeSnapshot(PROMPT), {})
    now += 599_999
    await classifyWithLlm(withTtl(600_000), intakeSnapshot(PROMPT), {})
    expect(call).toHaveBeenCalledTimes(1)
    now += 1
    await classifyWithLlm(withTtl(600_000), intakeSnapshot(PROMPT), {})
    expect(call).toHaveBeenCalledTimes(2)
    // The TTL is read when the entry is: shortening it takes effect at once.
    now += 1_000
    await classifyWithLlm(withTtl(500), intakeSnapshot(PROMPT), {})
    expect(call).toHaveBeenCalledTimes(3)
    const off = new ClassifierCache("s")
    await classifyWithLlm(
      deps(call, { cache: off, cacheTtlMs: 0 }),
      intakeSnapshot("Rewrite it"),
      {}
    )
    await classifyWithLlm(
      deps(call, { cache: off, cacheTtlMs: 0 }),
      intakeSnapshot("Rewrite it"),
      {}
    )
    expect(call).toHaveBeenCalledTimes(5)
    expect(off.size).toBe(0)
  })

  it("never caches a failure: the next request may be answered", async () => {
    const replies = ["not json", REPLY]
    const call = jest.fn(async () => replies.shift() ?? REPLY)
    const shared = deps(call)
    expect((await classifyWithLlm(shared, intakeSnapshot(PROMPT), {})).source).toBe(
      "rules_fallback"
    )
    expect((await classifyWithLlm(shared, intakeSnapshot(PROMPT), {})).source).toBe("llm")
    const timedOut = deps(jest.fn(hang), { timeoutMs: 10 })
    await classifyWithLlm(timedOut, intakeSnapshot("Rewrite this."), {})
    expect(timedOut.cache?.size).toBe(0)
  })

  it("keys entries by HMAC: no request text, and a different secret per account", () => {
    const one = classifierCacheFor("account-a")
    expect(classifierCacheFor("account-a")).toBe(one)
    const two = classifierCacheFor("account-b")
    expect(two).not.toBe(one)
    const text = normalizeClassifierText(`phase: intake\n\n${PROMPT}`)
    const hash = classifierConfigHash({ providerId: "openai", modelId: "gpt-5-mini" })
    const key = one.keyOf(text, hash)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain("capital")
    expect(one.keyOf(text, hash)).toBe(key)
    expect(two.keyOf(text, hash)).not.toBe(key)
  })

  it("stays bounded, dropping the least recently used entry", () => {
    const cache = new ClassifierCache("s", 2)
    cache.set("a", ANSWER, 0, 1_000)
    cache.set("b", ANSWER, 0, 1_000)
    expect(cache.get("a", 1, 1_000)).toEqual(ANSWER)
    cache.set("c", ANSWER, 0, 1_000)
    expect(cache.get("b", 1, 1_000)).toBeNull()
    expect(cache.get("a", 1, 1_000)).toEqual(ANSWER)
    expect(cache.size).toBe(2)
  })
})

// ── the host binding, against the real ledger ─────────────────────────────────

let dbCounter = 0
function freshStore(): FusionLedgerStore {
  const name = `fusion-classifier-test-${++dbCounter}`
  store = new FusionLedgerStore({ db: new FusionDB(name), codec: fusionContentCodec(name) })
  return store
}

function appSettings(
  classifier: Record<string, unknown> = {},
  surfaces: Record<string, boolean> = { chat: true, gatewayRuns: true, utilityLedger: true }
): AppSettings {
  const settings = {
    routerFusion: {
      enabled: true,
      surfaces,
      llmClassifier: {
        enabled: true,
        routerProviderId: "openai",
        routerModelId: "gpt-5-mini",
        ...classifier,
      },
    },
  } as unknown as AppSettings
  settingsState.settings = settings
  return settings
}

/** An LLM client whose usage snapshot grows by `usage` with every answered call. */
function fakeClient(reply: (prompt: string, options?: LlmClientCallOptions) => Promise<string>) {
  let snapshot: LlmUsageSnapshot = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const calls: Array<{ prompt: string; options?: LlmClientCallOptions }> = []
  const client: LlmClient = {
    async complete(prompt, options) {
      calls.push({ prompt, ...(options ? { options } : {}) })
      const text = await reply(prompt, options)
      snapshot = {
        inputTokens: snapshot.inputTokens + 900,
        outputTokens: snapshot.outputTokens + 60,
        totalTokens: snapshot.totalTokens + 960,
      }
      return text
    },
    getUsageSnapshot: () => snapshot,
  }
  return { client, calls }
}

function hostDeps(client: LlmClient | null) {
  return {
    buildClient: async () => client,
    accountKey: async () => "account-test",
  }
}

describe("createRouteClassifier", () => {
  beforeEach(() => {
    freshStore()
  })

  it("is absent while the classifier is off", () => {
    expect(createRouteClassifier(appSettings({ enabled: false }))).toBeNull()
    expect(createRouteClassifier({} as AppSettings)).toBeNull()
  })

  it("books one session-less utility run per classification on the routing surface", async () => {
    const { client, calls } = fakeClient(async () => REPLY)
    const classify = createRouteClassifier(appSettings(), hostDeps(client))!
    const outcome = await classify({
      snapshot: intakeSnapshot(PROMPT),
      hints: {},
      surface: "gatewayRuns",
      workspaceId: null,
    })
    expect(outcome.source).toBe("llm")
    expect(calls[0].options).toMatchObject({
      maxRetries: 0,
      maxTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
    })
    const runs = await store.db.fusionRuns.toArray()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      surface: "gatewayRuns",
      origin: "utility",
      sessionId: null,
      status: "succeeded",
    })
    const attempt = (await store.db.fusionCallAttempts.toArray())[0]
    expect(attempt).toMatchObject({
      logicalStepId: `utility:${CLASSIFIER_FEATURE_ID}`,
      deploymentId: "openai::gpt-5-mini",
      state: "SUCCEEDED",
    })
    // A repeat is answered from the cache: no second run.
    const again = await classify({
      snapshot: intakeSnapshot(PROMPT),
      hints: {},
      surface: "gatewayRuns",
      workspaceId: null,
    })
    expect(again.cached).toBe(true)
    expect(await store.db.fusionRuns.count()).toBe(1)
  })

  it("[ACC:ROUTE-03] keeps a timed-out classification's cost: the call is UNKNOWN and its money stays held", async () => {
    const { client } = fakeClient(hang)
    const classify = createRouteClassifier(appSettings({ timeoutMs: 60 }), hostDeps(client))!
    const outcome = await classify({
      snapshot: intakeSnapshot(PROMPT),
      hints: {},
      surface: "chat",
      workspaceId: null,
    })
    expect(outcome).toMatchObject({ source: "rules_fallback", fallback: { reason: "timeout" } })
    await until(async () => {
      const attempts = await store.db.fusionCallAttempts.toArray()
      return attempts[0]?.state === "UNKNOWN"
    }, "the aborted call to be booked")
    const run = (await store.db.fusionRuns.toArray())[0]
    expect(run).toMatchObject({ surface: "chat", origin: "utility", status: "failed" })
    expect(run.error).toMatchObject({ code: "CALL_OUTCOME_UNKNOWN" })
    // Never assumed free: the reservation is pinned against the tenant.
    expect((await store.getAccount()).activeHoldsMicrousd).toBeGreaterThan(0)
    expect(await store.db.fusionLedger.where("kind").equals("unknown").count()).toBe(1)
  })

  it("[ACC:ROUTE-03] keeps an unusable answer's cost: the call is settled from its usage", async () => {
    const { client } = fakeClient(async () => "I think this is a question.")
    const classify = createRouteClassifier(appSettings(), hostDeps(client))!
    const outcome = await classify({
      snapshot: intakeSnapshot(PROMPT),
      hints: {},
      surface: "chat",
      workspaceId: null,
    })
    expect(outcome).toMatchObject({
      source: "rules_fallback",
      fallback: { reason: "invalid_json" },
    })
    const run = (await store.db.fusionRuns.toArray())[0]
    expect(run.status).toBe("succeeded")
    expect(run.budget.spentMicrousd).toBeGreaterThan(0)
    expect(await store.db.fusionLedger.where("kind").equals("settle").count()).toBe(1)
  })

  it("falls back without sending anything when the ledger refuses the call", async () => {
    const { client, calls } = fakeClient(async () => REPLY)
    // The surface was switched off after the route was made: the live re-check refuses.
    const classify = createRouteClassifier(
      appSettings({}, { chat: false, gatewayRuns: true }),
      hostDeps(client)
    )!
    const outcome = await classify({
      snapshot: intakeSnapshot(PROMPT),
      hints: {},
      surface: "chat",
      workspaceId: null,
    })
    expect(outcome.fallback).toEqual({ reason: "refused", code: "ROUTER_FUSION_DISABLED" })
    expect(calls).toHaveLength(0)
  })

  it("falls back on a ledger fault and never sends the call unledgered", async () => {
    const { client, calls } = fakeClient(async () => REPLY)
    storeFault.error = Object.assign(new Error("open failed"), { name: "OpenFailedError" })
    const classify = createRouteClassifier(appSettings(), hostDeps(client))!
    const outcome = await classify({
      snapshot: intakeSnapshot(PROMPT),
      hints: {},
      surface: "chat",
      workspaceId: null,
    })
    expect(outcome.fallback).toEqual({ reason: "infrastructure", code: "db_unavailable" })
    expect(calls).toHaveLength(0)
  })

  it("never opens a run for a request the PII gate objects to", async () => {
    const { client, calls } = fakeClient(async () => REPLY)
    const classify = createRouteClassifier(appSettings(), hostDeps(client))!
    const outcome = await classify({
      snapshot: intakeSnapshot("Write to dana@example.com about the invoice"),
      hints: {},
      surface: "chat",
      workspaceId: null,
    })
    expect(outcome.fallback).toEqual({ reason: "pii_blocked" })
    expect(calls).toHaveLength(0)
    expect(await store.db.fusionRuns.count()).toBe(0)
  })

  it("says why no call could be made: no router model, or none callable here", async () => {
    const unset = createRouteClassifier(
      appSettings({ routerProviderId: undefined, routerModelId: undefined }),
      hostDeps(null)
    )!
    expect(
      (
        await unset({
          snapshot: intakeSnapshot(PROMPT),
          hints: {},
          surface: "chat",
          workspaceId: null,
        })
      ).fallback
    ).toEqual({ reason: "model_unset" })
    const unavailable = createRouteClassifier(appSettings(), hostDeps(null))!
    expect(
      (
        await unavailable({
          snapshot: intakeSnapshot(PROMPT),
          hints: {},
          surface: "chat",
          workspaceId: null,
        })
      ).fallback
    ).toEqual({ reason: "model_unavailable" })
    expect(await store.db.fusionRuns.count()).toBe(0)
  })

  it("keeps each account's classifications apart", async () => {
    const { client, calls } = fakeClient(async () => REPLY)
    const settings = appSettings()
    const forAccount = (account: string) =>
      createRouteClassifier(settings, {
        buildClient: async () => client,
        accountKey: async () => account,
      })!
    const request = {
      snapshot: intakeSnapshot(PROMPT),
      hints: {},
      surface: "chat" as const,
      workspaceId: null,
    }
    await forAccount("a")(request)
    await forAccount("a")(request)
    await forAccount("b")(request)
    expect(calls).toHaveLength(2)
  })
})

describe("judgeDifficultyWithClassifier (the absorbed difficulty judge)", () => {
  beforeEach(() => {
    freshStore()
  })

  it("names a tier from the classifier's labels, booked on the utility surface", async () => {
    const { client } = fakeClient(async () =>
      JSON.stringify({ ...ANSWER, task: "research.synthesis", ambiguity: "medium" })
    )
    expect(
      await judgeDifficultyWithClassifier(appSettings(), { promptText: PROMPT }, hostDeps(client))
    ).toEqual({ tier: "powerful" })
    expect((await store.db.fusionRuns.toArray())[0]).toMatchObject({
      surface: "utilityLedger",
      origin: "utility",
    })
  })

  it("answers null — the deterministic tier stands — on any fallback, and while off", async () => {
    const { client } = fakeClient(async () => "no json here")
    expect(
      await judgeDifficultyWithClassifier(appSettings(), { promptText: PROMPT }, hostDeps(client))
    ).toBeNull()
    expect(
      await judgeDifficultyWithClassifier(
        appSettings({ enabled: false }),
        { promptText: PROMPT },
        hostDeps(client)
      )
    ).toBeNull()
    const { client: unknownTask } = fakeClient(async () =>
      JSON.stringify({ ...ANSWER, task: "unknown" })
    )
    expect(
      await judgeDifficultyWithClassifier(
        appSettings(),
        { promptText: "Something else entirely" },
        hostDeps(unknownTask)
      )
    ).toBeNull()
  })
})
