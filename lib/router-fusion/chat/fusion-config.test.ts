import {
  DEFAULT_ROUTER_FUSION_SETTINGS,
  normalizeRouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"

import {
  buildFusionConfig,
  buildFusionRegistry,
  deploymentIdOf,
  usdPerMillionDecimal,
  type DeploymentFacts,
  type DeploymentRef,
} from "./fusion-config"

const GPT: DeploymentRef = { providerId: "openai", modelId: "gpt-5" }
const MINI: DeploymentRef = { providerId: "openai", modelId: "gpt-5-mini" }
const CLAUDE: DeploymentRef = { providerId: "anthropic", modelId: "claude-sonnet-5" }
const LLAMA: DeploymentRef = { providerId: "ollama", modelId: "llama3:8b" }
const ROUTER: DeploymentRef = { providerId: "openrouter", modelId: "some/model" }

function facts(overrides: Partial<Record<string, Partial<DeploymentFacts>>> = {}) {
  const base: Record<string, DeploymentFacts> = {
    [deploymentIdOf(GPT)]: {
      capabilities: { tools: true, vision: true },
      contextWindow: 200_000,
      pricing: { promptPer1M: 1.25, completionPer1M: 10, cachedInputPer1M: 0.125 },
      local: false,
      subscription: false,
      lane: "ai-sdk",
      aggregator: false,
    },
    [deploymentIdOf(MINI)]: {
      capabilities: {},
      pricing: { promptPer1M: 0.25 },
      local: false,
      subscription: false,
      lane: "ai-sdk",
      aggregator: false,
    },
    [deploymentIdOf(CLAUDE)]: {
      capabilities: { tools: true },
      pricing: { promptPer1M: 3, completionPer1M: 15, cacheCreationPer1M: 3.75 },
      local: false,
      subscription: false,
      lane: "claude-agent-sdk",
      aggregator: false,
    },
    [deploymentIdOf(LLAMA)]: {
      local: true,
      subscription: false,
      lane: "ai-sdk",
      aggregator: false,
    },
    [deploymentIdOf(ROUTER)]: {
      pricing: { promptPer1M: 1, completionPer1M: 1 },
      local: false,
      subscription: false,
      lane: "ai-sdk",
      aggregator: true,
    },
  }
  for (const [id, patch] of Object.entries(overrides))
    base[id] = { ...base[id], ...patch } as DeploymentFacts
  return (ref: DeploymentRef) => base[deploymentIdOf(ref)]
}

describe("usdPerMillionDecimal", () => {
  it("renders contract decimals rounded up, never down", () => {
    expect(usdPerMillionDecimal(3)).toBe("3")
    expect(usdPerMillionDecimal(0.15)).toBe("0.15")
    expect(usdPerMillionDecimal(1.25)).toBe("1.25")
    expect(usdPerMillionDecimal(0.0000001)).toBe("0.000001")
    expect(usdPerMillionDecimal(0)).toBe("0")
    expect(usdPerMillionDecimal(-1)).toBeNull()
    expect(usdPerMillionDecimal(Number.NaN)).toBeNull()
  })
})

describe("buildFusionRegistry", () => {
  const registry = buildFusionRegistry({
    deployments: [GPT, MINI, CLAUDE, LLAMA, ROUTER],
    aliases: { powerful: [GPT, CLAUDE], fast: [MINI], empty: [] },
    factsOf: facts(),
  })
  const byId = Object.fromEntries(registry.deployments.map((d) => [d.id, d]))

  it("sizes each window from what discovery reported, and a conservative default otherwise", () => {
    // PAN-08's context precheck reads these limits: a known window is used as
    // reported, a missing one falls back to 32k in and 8k out rather than an
    // optimistic guess.
    expect(byId[deploymentIdOf(GPT)]).toMatchObject({
      contextLimit: 200_000,
      maxOutputTokens: 8192,
    })
    expect(byId[deploymentIdOf(MINI)]).toMatchObject({
      contextLimit: 32_000,
      maxOutputTokens: 8192,
    })
    const sized = buildFusionRegistry({
      deployments: [MINI, CLAUDE],
      aliases: { fast: [MINI], powerful: [CLAUDE] },
      factsOf: facts({
        [deploymentIdOf(MINI)]: {
          capabilities: { contextTokens: 128_000 },
          maxOutputTokens: 16_384.9,
        },
        [deploymentIdOf(CLAUDE)]: { contextWindow: 0.4, maxOutputTokens: 0 },
      }),
    })
    const sizedById = Object.fromEntries(sized.deployments.map((d) => [d.id, d]))
    expect(sizedById[deploymentIdOf(MINI)]).toMatchObject({
      contextLimit: 128_000,
      maxOutputTokens: 16_384,
    })
    // A nonsense report never becomes a zero-sized window.
    expect(sizedById[deploymentIdOf(CLAUDE)]).toMatchObject({ contextLimit: 1, maxOutputTokens: 1 })
  })

  it("prices a deployment only when both base rates are known", () => {
    const gpt = byId[deploymentIdOf(GPT)]
    const card = registry.rate_cards.find((c) => c.id === gpt.rateCardId)
    expect(card).toMatchObject({
      ordinary_input_per_million: "1.25",
      output_per_million: "10",
      cache_read_per_million: "0.125",
      cache_write_5m_per_million: "1.5625",
      cache_write_1h_per_million: "2.5",
    })
    expect(byId[deploymentIdOf(MINI)].rateCardId).toBeNull()
  })

  it("gives local models an audited zero card and every data class", () => {
    const llama = byId[deploymentIdOf(LLAMA)]
    expect(registry.rate_cards.find((c) => c.id === llama.rateCardId)?.output_per_million).toBe("0")
    expect(llama.dataClasses).toEqual(["public", "internal", "restricted"])
    expect(llama.cacheMode).toBe("none")
  })

  it("never lets an aggregator take restricted data", () => {
    expect(byId[deploymentIdOf(ROUTER)].dataClasses).toEqual(["public", "internal"])
    expect(byId[deploymentIdOf(GPT)].dataClasses).toContain("restricted")
  })

  it("marks the Agent SDK lane as estimated with observable retries", () => {
    expect(byId[deploymentIdOf(CLAUDE)]).toMatchObject({
      billingTransparency: "estimated",
      internalRetry: "observable",
      cacheMode: "explicit",
    })
    expect(byId[deploymentIdOf(GPT)]).toMatchObject({
      billingTransparency: "bounded",
      internalRetry: "none",
    })
  })

  it("treats unknown capabilities as unsupported unless the user pinned the deployment", () => {
    expect(byId[deploymentIdOf(MINI)]).toMatchObject({
      supportsTools: false,
      inputModalities: ["text"],
    })
    const pinned = buildFusionRegistry({
      deployments: [MINI],
      aliases: {},
      pinned: MINI,
      factsOf: facts(),
    })
    expect(pinned.deployments[0]).toMatchObject({
      supportsTools: true,
      inputModalities: ["text", "image"],
    })
  })

  it("keeps alias order and drops empty aliases", () => {
    expect(registry.aliases).toEqual({
      powerful: [deploymentIdOf(GPT), deploymentIdOf(CLAUDE)],
      fast: [deploymentIdOf(MINI)],
    })
  })
})

describe("buildFusionConfig", () => {
  const registry = buildFusionRegistry({
    deployments: [GPT, MINI],
    aliases: { powerful: [GPT], fast: [MINI] },
    factsOf: facts(),
  })

  it("compiles the actions whose tiers exist and names the ones it left out", () => {
    const { config, omittedActions } = buildFusionConfig(
      DEFAULT_ROUTER_FUSION_SETTINGS,
      registry,
      "production"
    )
    expect(Object.keys(config.actions).sort()).toEqual([
      "cascade_code",
      "cascade_review",
      "cascade_schema",
      "delegate_code",
      "direct_baseline",
      "direct_economy",
    ])
    expect(omittedActions).toEqual([{ actionId: "panel_review", reason: "alias_missing:balanced" }])
    expect(config.actions.direct_baseline.extension.run_cap_microusd).toBe(500_000)
  })

  it("applies run caps and overrides from settings, changing the action hash", () => {
    const base = buildFusionConfig(DEFAULT_ROUTER_FUSION_SETTINGS, registry, "production").config
    const settings = normalizeRouterFusionSettings({
      runCapUsdByMode: { direct: "0.25" },
      actionOverrides: { direct_economy: { enabled: false, limits: { max_model_calls: 32 } } },
    })
    const { config } = buildFusionConfig(settings, registry, "production")
    expect(config.actions.direct_baseline.extension.run_cap_microusd).toBe(250_000)
    expect(config.actions.direct_economy.config.enabled).toBe(false)
    expect(config.actions.direct_economy.extension.limits.max_model_calls).toBe(32)
    expect(config.actions.direct_baseline.actionHash).not.toBe(
      base.actions.direct_baseline.actionHash
    )
    expect(config.digest).not.toBe(base.digest)
  })
})
