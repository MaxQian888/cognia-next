import {
  BUILT_IN_PROVIDER_IDS,
  buildDefaultBuiltInProviderSettings,
  buildQuickAddProviderPresets,
  ANTHROPIC_FALLBACK_MODEL_ID,
  getBuiltInProviderCatalog,
  getBuiltInProviderCatalogEntry,
  getBuiltInProviderDefaultBaseURL,
  getBuiltInProviderDefaultModel,
  getBuiltInProviderProtocol,
  getBuiltInProviderSettingsBaseURL,
  isBuiltInProviderId,
} from "./built-in-provider-catalog"

describe("built-in provider catalog", () => {
  it("keeps ids, entries, and lookup helpers aligned", () => {
    const catalog = getBuiltInProviderCatalog()

    expect(catalog).toHaveLength(BUILT_IN_PROVIDER_IDS.length)
    expect(isBuiltInProviderId("openai")).toBe(true)
    expect(isBuiltInProviderId("custom")).toBe(false)
    expect(getBuiltInProviderCatalogEntry("openai")).toMatchObject({
      id: "openai",
      protocol: "openai",
      defaultModel: getBuiltInProviderDefaultModel("openai"),
    })
    expect(getBuiltInProviderProtocol("google")).toBe("gemini")
  })

  it("registers Amazon Bedrock as a native, region-aware provider", () => {
    expect(getBuiltInProviderCatalogEntry("bedrock")).toMatchObject({
      protocol: "bedrock",
      family: "bedrock-native",
      adapter: "bedrock",
      apiKeyRequired: false,
      baseURLRequired: false,
    })
  })

  it("marks built-in providers without a working chat endpoint as non-chat", () => {
    for (const providerId of ["replicate", "baidu", "tencent", "voyage", "jina", "fal"]) {
      expect(getBuiltInProviderCatalogEntry(providerId)?.supportsChat).toBe(false)
    }
  })

  it("builds default settings from catalog credential and base URL requirements", () => {
    const settings = buildDefaultBuiltInProviderSettings()

    expect(settings.openai).toMatchObject({ providerId: "openai", apiKey: "", enabled: true })
    expect(settings.ollama).toMatchObject({
      providerId: "ollama",
      apiKey: undefined,
      baseURL: getBuiltInProviderSettingsBaseURL("ollama"),
    })
    expect(getBuiltInProviderDefaultBaseURL("deepseek")).toContain("deepseek")
  })

  it("uses current production model fallbacks for flagship providers", () => {
    expect(getBuiltInProviderDefaultModel("openai")).toBe("gpt-6.1-sol")
    expect(getBuiltInProviderDefaultModel("anthropic")).toBe("claude-sonnet-5-5")
    expect(getBuiltInProviderDefaultModel("google")).toBe("gemini-3.8-flash")
    expect(getBuiltInProviderDefaultModel("xai")).toBe("grok-4.7")

    expect(
      getBuiltInProviderCatalogEntry("google")?.models?.find(
        (model) => model.id === "gemini-3.8-flash"
      )
    ).toMatchObject({
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
    })
    expect(
      getBuiltInProviderCatalogEntry("xai")?.models?.find((model) => model.id === "grok-4.7")
    ).toMatchObject({
      contextLength: 500_000,
      maxOutputTokens: 500_000,
      supportsReasoning: true,
      supportsVision: true,
    })
  })

  it.each([
    ["xai", "grok-4.7", "grok-4.5"],
    ["qwen", "qwen3.8-max", "qwen-max"],
    ["minimax", "MiniMax-M3", "MiniMax-M2.7"],
    ["bedrock", "us.anthropic.claude-sonnet-5-5", "us.anthropic.claude-sonnet-5"],
    ["volcengine", "doubao-seed-2-1-pro-260628", "doubao-pro-256k"],
    ["opencode", "kimi-k2.7-code", "claude-sonnet-4-6"],
  ])("updates %s recommendations without deleting earlier choices", (providerId, current, old) => {
    const provider = getBuiltInProviderCatalogEntry(providerId)
    expect(provider?.defaultModel).toBe(current)
    expect(provider?.models?.map((model) => model.id)).toEqual(
      expect.arrayContaining([current, old])
    )
    expect(provider?.models?.find((model) => model.id === current)?.recommendedFor).toContain(
      "coding"
    )
  })

  it("keeps economical defaults alongside current flagship options", () => {
    expect(getBuiltInProviderDefaultModel("moonshot")).toBe("kimi-k2.7-code")
    expect(getBuiltInProviderDefaultModel("google")).toBe("gemini-3.8-flash")
    expect(getBuiltInProviderDefaultModel("zhipu")).toBe("glm-4.7-flash")
    expect(
      getBuiltInProviderCatalogEntry("moonshot")?.models?.find((model) => model.id === "kimi-k3")
    ).toMatchObject({ contextLength: 1048576, supportsVision: true, supportsTemperature: false })
    expect(
      getBuiltInProviderCatalogEntry("google")?.models?.find(
        (model) => model.id === "gemini-4-argon"
      )
    ).toMatchObject({ maxOutputTokens: 65536, supportsReasoning: true })
    expect(getBuiltInProviderCatalogEntry("zhipu")?.codingPackage?.defaultModel).toBe("glm-5.3")
  })

  it("corrects baseline capabilities without repurposing legacy ids", () => {
    const model = (providerId: string, id: string) =>
      getBuiltInProviderCatalogEntry(providerId)?.models?.find((item) => item.id === id)
    expect(model("deepseek", "deepseek-flash")?.maxOutputTokens).toBe(393216)
    expect(model("mistral", "mistral-medium-latest")?.contextLength).toBe(262144)
    expect(model("siliconflow", "deepseek-ai/DeepSeek-V3.2")).toMatchObject({
      contextLength: 164000,
      maxOutputTokens: 164000,
    })
    expect(model("moonshot", "kimi-k2.7-code")).toMatchObject({
      contextLength: 262144,
      supportsVision: true,
      supportsTemperature: false,
    })
    expect(model("perplexity", "sonar-pro")).toMatchObject({
      supportsVision: true,
      supportsTools: false,
      maxOutputTokens: 8192,
    })
    expect(model("qwen", "qwen-max")?.supportsVision).toBe(false)
    expect(model("huggingface", "Qwen/Qwen3-Coder-480B-A35B-Instruct")).toMatchObject({
      contextLength: 262144,
      maxOutputTokens: 66536,
    })
    expect(model("zhipu", "glm-4.7-flash")?.maxOutputTokens).toBe(131072)
    expect(model("bedrock", "us.anthropic.claude-sonnet-5-5")?.supportsTemperature).toBe(false)
  })

  it("omits unsupported sampling for the current GPT-6 family on both built-in providers", () => {
    for (const providerId of ["openai", "codex"]) {
      for (const id of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]) {
        expect(
          getBuiltInProviderCatalogEntry(providerId)?.models?.find((model) => model.id === id)
            ?.supportsTemperature
        ).toBe(false)
      }
    }
  })

  it("stops endorsing unavailable coding recommendations without declaring them retired", () => {
    for (const [providerId, id] of [
      ["togetherai", "Qwen/Qwen3-Coder-480B-A35B-Instruct"],
      ["siliconflow", "Pro/Qwen/Qwen3-Coder-480B-A35B-Instruct"],
      ["zhipu", "glm-5-turbo"],
      ["minimax", "MiniMax-M2.1-highspeed"],
      ["opencode-go", "kimi-k2.6"],
      ["opencode-go", "glm-5.1"],
    ]) {
      const model = getBuiltInProviderCatalogEntry(providerId)?.models?.find(
        (item) => item.id === id
      )
      expect(model).toBeDefined()
      expect(model?.recommendedFor ?? []).not.toContain("coding")
    }
  })

  it("uses wire-compatible OpenCode and Perplexity defaults", () => {
    expect(getBuiltInProviderCatalogEntry("opencode")).toMatchObject({
      defaultModel: "kimi-k2.7-code",
      defaultBaseURL: "https://opencode.ai/inference/openai/v1",
      protocol: "openai",
    })
    expect(getBuiltInProviderCatalogEntry("perplexity")).toMatchObject({
      defaultModel: "preset/fast",
      defaultBaseURL: "https://api.perplexity.ai/v1",
    })
    expect(getBuiltInProviderDefaultModel("ai21")).toBe("jamba-large")
  })

  it("ships complete first-party OpenAI and Anthropic model choices", () => {
    const openai = getBuiltInProviderCatalogEntry("openai")
    expect(openai?.models?.map((model) => model.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-5.6",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ])
    expect(openai?.models?.[0]).toMatchObject({
      contextLength: 1_050_000,
      maxOutputTokens: 128_000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      pricing: { promptPer1M: 2, completionPer1M: 10, cachedInputPer1M: 0.1 },
    })

    const anthropic = getBuiltInProviderCatalogEntry("anthropic")
    expect(anthropic?.models?.map((model) => model.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5",
      "claude-opus-4-8",
      // `claude-opus-5` was blessed by both effort gates but existed in no
      // catalog entry — a model the gate vouched for that no picker could
      // offer and no send could resolve.
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ])
    expect(anthropic?.models?.find((model) => model.id === "claude-sonnet-5")).toMatchObject({
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      pricing: { promptPer1M: 3, completionPer1M: 15 },
    })
  })

  it("refreshes invalid or superseded defaults while retaining historical model ids", () => {
    expect(getBuiltInProviderDefaultModel("codex")).toBe("gpt-6.1-sol")
    expect(getBuiltInProviderDefaultModel("deepseek")).toBe("deepseek-flash")
    expect(getBuiltInProviderDefaultModel("openrouter")).toBe("anthropic/claude-sonnet-5.5")

    for (const [providerId, historicalId] of [
      ["openai", "gpt-5.6"],
      ["codex", "gpt-5.6-sol"],
      ["anthropic", "claude-sonnet-5"],
      ["google", "gemini-3.6-flash"],
      ["deepseek", "deepseek-v4-flash"],
    ]) {
      const provider = getBuiltInProviderCatalogEntry(providerId)
      expect(provider?.models?.some((model) => model.id === historicalId)).toBe(true)
      expect(provider?.models?.some((model) => model.id === provider.defaultModel)).toBe(true)
    }
    expect(getBuiltInProviderCatalogEntry("openrouter")?.models?.[0]).toMatchObject({
      id: "anthropic/claude-sonnet-5.5",
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      pricing: { promptPer1M: 2, completionPer1M: 10, cachedInputPer1M: 0.1 },
    })
  })

  it("keeps current capability and pricing facts on the recommended model rows", () => {
    expect(
      getBuiltInProviderCatalogEntry("anthropic")?.models?.find(
        (model) => model.id === "claude-sonnet-5-5"
      )
    ).toMatchObject({
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      pricing: { promptPer1M: 2, completionPer1M: 10 },
    })
    expect(
      getBuiltInProviderCatalogEntry("deepseek")?.models?.find(
        (model) => model.id === "deepseek-flash"
      )
    ).toMatchObject({
      contextLength: 1_000_000,
      maxOutputTokens: 393_216,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      pricing: { promptPer1M: 0.3, completionPer1M: 1.2, cachedInputPer1M: 0.006 },
    })
    expect(
      getBuiltInProviderCatalogEntry("google")?.models?.find(
        (model) => model.id === "gemini-3.8-flash"
      )
    ).toMatchObject({
      supportsAudio: true,
      supportsVideo: true,
      pricing: { promptPer1M: 1.5, completionPer1M: 7.5, cachedInputPer1M: 0.15 },
    })
  })

  it.each([
    [
      "fireworks",
      "accounts/fireworks/models/deepseek-v4p1-flash-1017",
      "accounts/fireworks/models/deepseek-v4-pro",
    ],
    ["nvidia", "nvidia/nemotron-3.5-super-vl-120b-a12b", "nvidia/nemotron-3-super-120b-a12b"],
    ["opencode-go", "kimi-k2.7-code", "kimi-k2.6"],
  ])(
    "refreshes %s recommendations without losing its historical model",
    (providerId, recommendedId, historicalId) => {
      const provider = getBuiltInProviderCatalogEntry(providerId)
      expect(provider?.defaultModel).toBe(recommendedId)
      expect(provider?.models?.map((model) => model.id)).toEqual(
        expect.arrayContaining([recommendedId, historicalId])
      )
      expect(provider?.models?.find((model) => model.id === recommendedId)).toMatchObject({
        supportsTools: true,
        supportsVision: true,
        supportsReasoning: true,
      })
    }
  )

  it("uses the documented current OpenCode Go endpoint for its recommendation", () => {
    expect(getBuiltInProviderCatalogEntry("opencode-go")).toMatchObject({
      defaultBaseURL: "https://opencode.ai/inference/go/openai/v1",
      docsUrl: "https://opencode.ai/v2/docs/console/go/",
    })
    expect(
      getBuiltInProviderCatalogEntry("opencode-go")?.models?.find(
        (model) => model.id === "kimi-k2.7-code"
      )
    ).toMatchObject({
      id: "kimi-k2.7-code",
      contextLength: 262_144,
      maxOutputTokens: 262_144,
      supportsTemperature: false,
      pricing: { promptPer1M: 0.95, completionPer1M: 4, cachedInputPer1M: 0.19 },
    })
  })

  it("uses active Groq production models and current Mistral aliases", () => {
    const groq = getBuiltInProviderCatalogEntry("groq")
    expect(groq?.defaultModel).toBe("openai/gpt-oss-120b")
    expect(groq?.models?.map((model) => model.id)).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3.6-27b",
      "groq/compound",
      "groq/compound-mini",
    ])

    const mistral = getBuiltInProviderCatalogEntry("mistral")
    expect(mistral?.defaultModel).toBe("mistral-medium-latest")
    expect(mistral?.models?.map((model) => model.id)).toEqual(
      expect.arrayContaining(["mistral-medium-latest", "mistral-small-latest"])
    )
  })

  it("registers cc-switch Anthropic-wire relay presets under the anthropic-native family", () => {
    const relay = getBuiltInProviderCatalogEntry("deepseek-anthropic")
    expect(relay).toMatchObject({
      protocol: "anthropic",
      family: "anthropic-native",
      adapter: "anthropic",
      defaultEnabled: false,
    })
    expect(getBuiltInProviderDefaultBaseURL("glm-anthropic")).toContain("bigmodel.cn")
    expect(getBuiltInProviderDefaultBaseURL("glm-anthropic-intl")).toContain("z.ai")
    // Distinct from the existing OpenAI-compatible DeepSeek entry.
    expect(getBuiltInProviderProtocol("deepseek")).toBe("openai")
    expect(getBuiltInProviderProtocol("deepseek-anthropic")).toBe("anthropic")
  })

  it("gives every anthropic-native relay a non-empty model list containing its default", () => {
    const catalog = getBuiltInProviderCatalog()
    const relays = catalog.filter((e) => e.family === "anthropic-native" && e.defaultBaseURL)
    expect(relays.length).toBeGreaterThanOrEqual(20)
    for (const e of relays) {
      const ids = (e.models ?? []).map((m) => m.id)
      // No relay ships an empty dropdown, and the default is selectable.
      expect(ids.length).toBeGreaterThan(0)
      expect(ids).toContain(e.defaultModel)
    }
    // Kimi specifically (the reported case) carries a current kimi-k2 model.
    expect(getBuiltInProviderDefaultModel("kimi-anthropic")).toBe("kimi-k2.7-code")
    expect(
      (getBuiltInProviderCatalogEntry("kimi-anthropic")?.models ?? []).map((m) => m.id)
    ).toContain("kimi-k2.7-code")
  })

  it("stamps relayOf on every vendor relay so Phase 1 can derive deployments (ADR-0090)", () => {
    const catalog = getBuiltInProviderCatalog()

    // Every `*-anthropic`-suffixed relay names its vendor.
    for (const entry of catalog.filter((e) => e.id.endsWith("-anthropic"))) {
      expect(entry.relayOf).toBeTruthy()
      expect(entry.relayOf).not.toBe(entry.id)
    }
    // Suffix-less coding relays too.
    expect(getBuiltInProviderCatalogEntry("kimi-coding")?.relayOf).toBe("moonshot")
    expect(getBuiltInProviderCatalogEntry("kimi-anthropic")?.relayOf).toBe("moonshot")
    expect(getBuiltInProviderCatalogEntry("glm-anthropic")?.relayOf).toBe("zhipu")
    expect(getBuiltInProviderCatalogEntry("glm-anthropic-intl")?.relayOf).toBe("zhipu")
    expect(getBuiltInProviderCatalogEntry("volcengine-agentplan")?.relayOf).toBe("volcengine")
    // A relayOf naming an in-catalog vendor must resolve; slugs without a
    // catalog entry (qianfan, longcat, …) are synthesized at migration time.
    for (const entry of catalog) {
      if (!entry.relayOf) continue
      const vendor = getBuiltInProviderCatalogEntry(entry.relayOf)
      if (vendor) expect(vendor.id).toBe(entry.relayOf)
    }
    // The Anthropic first-party entry and standalone anthropic-wire
    // aggregators are vendors, not relays.
    expect(getBuiltInProviderCatalogEntry("anthropic")?.relayOf).toBeUndefined()
    expect(getBuiltInProviderCatalogEntry("packycode")?.relayOf).toBeUndefined()
    expect(getBuiltInProviderCatalogEntry("shengsuanyun")?.relayOf).toBeUndefined()
  })

  it("creates quick-add presets only for entries with default base URLs", () => {
    const presets = buildQuickAddProviderPresets()

    expect(presets.length).toBeGreaterThan(0)
    expect(presets.every((preset) => preset.baseURL.length > 0)).toBe(true)
    expect(presets.every((preset) => preset.models.includes(preset.defaultModel))).toBe(true)
    expect(
      presets.every((preset) =>
        preset.modelEntries.some((model) => model.id === preset.defaultModel)
      )
    ).toBe(true)
    expect(presets.some((preset) => preset.id === "modelscope")).toBe(true)
  })
})

describe("effort-gate parity", () => {
  // The gates in `lib/ai/reasoning-capability.ts` and
  // `packages/provider-core/.../reasoning-tiers.ts` are pinned to each other,
  // but nothing pinned either of them to the catalog. `claude-opus-5` and
  // `claude-mythos-5` were both blessed while existing in no entry: one was a
  // real model missing its row, the other was not a model at all. Narrowing a
  // real model silently removes effort support; blessing a fake one silently
  // mis-prices. This asserts the missing direction.
  const ANTHROPIC_EFFORT_FRAGMENTS = [
    /opus-4-(?:5|6|7|8|9)/,
    /sonnet-4-6/,
    /(?:opus|sonnet|fable)-5/,
    /haiku-5[-.]5(?:$|[-@:/])/,
  ]

  // Haiku 4.5 reasons but still rejects the `effort` parameter — documented in
  // `reasoning-capability.ts` and the one deliberate exclusion.
  const NO_EFFORT_ALLOWLIST = new Set(["claude-haiku-4-5-20251001"])

  it("blesses only model families the catalog actually carries", () => {
    // Scanned across EVERY entry, not just the first-party Anthropic one:
    // `sonnet-4-6` is legitimately served by the Anthropic-wire relays and by
    // aggregators, so narrowing the search to one provider would report a
    // live family as dead.
    const ids = getBuiltInProviderCatalog().flatMap((provider) =>
      (provider.models ?? []).map((model) => model.id)
    )
    for (const fragment of ANTHROPIC_EFFORT_FRAGMENTS) {
      expect({ fragment: fragment.source, matched: ids.some((id) => fragment.test(id)) }).toEqual({
        fragment: fragment.source,
        matched: true,
      })
    }
  })

  it("leaves no catalogued Anthropic model unaccounted for", () => {
    const anthropic = getBuiltInProviderCatalogEntry("anthropic")
    for (const model of anthropic?.models ?? []) {
      if (NO_EFFORT_ALLOWLIST.has(model.id)) continue
      expect({
        id: model.id,
        blessed: ANTHROPIC_EFFORT_FRAGMENTS.some((fragment) => fragment.test(model.id)),
      }).toEqual({ id: model.id, blessed: true })
    }
  })
})

describe("ANTHROPIC_FALLBACK_MODEL_ID", () => {
  it("matches the entry's own default, so the one literal cannot go stale", () => {
    expect(ANTHROPIC_FALLBACK_MODEL_ID).toBe(
      getBuiltInProviderCatalogEntry("anthropic")?.defaultModel
    )
  })
})
