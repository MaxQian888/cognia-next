import {
  buildProviderModelDiscoverySnapshot,
  buildBuiltInProviderModelDiscoverySnapshot,
  type ProviderModelCandidate,
  type ProviderModelDiscoverySnapshot,
  parseProviderModelWire,
  parseProviderModelsWire,
  buildCustomProviderModelDiscoverySnapshot,
  modelConfigToProviderModelCandidate,
  discoverOpenAICompatibleModels,
} from "./model-discovery"
import { proxyFetch } from "./runtime-adapters"

jest.mock("./runtime-adapters", () => ({ proxyFetch: jest.fn() }))

function byId(snapshot: ProviderModelDiscoverySnapshot, id: string) {
  return snapshot.models.find((m) => m.id === id)
}

describe("buildProviderModelDiscoverySnapshot — layered authority", () => {
  it("models.dev overwrites static model-level fields", () => {
    const catalogModels: ProviderModelCandidate[] = [
      { id: "m1", name: "M1 (static)", contextLength: 8000, supportsVision: false },
    ]
    const modelsDevModels: ProviderModelCandidate[] = [
      {
        id: "m1",
        name: "M1 (models.dev)",
        contextLength: 200000,
        supportsVision: true,
        pricing: { promptPer1M: 3, completionPer1M: 15 },
      },
    ]
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      catalogModels,
      modelsDevModels,
    })
    const m1 = byId(snap, "m1")!
    expect(m1.contextLength).toBe(200000)
    expect(m1.supportsVision).toBe(true)
    expect(m1.name).toBe("M1 (models.dev)")
    expect(m1.pricing).toMatchObject({ promptPer1M: 3, completionPer1M: 15 })
    expect(m1.mergedSources).toEqual(["catalog-static", "models-dev"])
  })

  it("remote-discovered does NOT clobber models.dev pricing/capabilities", () => {
    const modelsDevModels: ProviderModelCandidate[] = [
      {
        id: "m1",
        name: "M1",
        contextLength: 200000,
        supportsVision: true,
        pricing: { promptPer1M: 3, completionPer1M: 15 },
      },
    ]
    // Bare /v1/models entry: no pricing, no real context, vision unknown.
    const remoteModels: ProviderModelCandidate[] = [{ id: "m1", name: "m1" }]
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      modelsDevModels,
      remoteModels,
      remoteLastFetchedAt: 123,
    })
    const m1 = byId(snap, "m1")!
    // pricing + capabilities survive the bare remote entry
    expect(m1.pricing).toMatchObject({ promptPer1M: 3, completionPer1M: 15 })
    expect(m1.contextLength).toBe(200000)
    expect(m1.supportsVision).toBe(true)
    expect(m1.mergedSources).toEqual(["models-dev", "remote-discovered"])
  })

  it("does NOT downgrade a models.dev model's source/freshness when the live list also has it", () => {
    const modelsDevModels: ProviderModelCandidate[] = [
      { id: "m1", contextLength: 200000, pricing: { promptPer1M: 3, completionPer1M: 15 } },
    ]
    const remoteModels: ProviderModelCandidate[] = [{ id: "m1", name: "m1" }]
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      modelsDevModels,
      remoteModels,
      remoteLastFetchedAt: 123,
    })
    const m1 = byId(snap, "m1")!
    // Provenance stays models-dev (the higher-authority source); only the
    // mergedSources audit trail records the additional remote contribution.
    expect(m1.source).toBe("models-dev")
    expect(m1.mergedSources).toEqual(["models-dev", "remote-discovered"])
  })

  it("remote-discovered still contributes brand-new model ids", () => {
    const modelsDevModels: ProviderModelCandidate[] = [{ id: "m1" }]
    const remoteModels: ProviderModelCandidate[] = [{ id: "m2-new" }]
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      modelsDevModels,
      remoteModels,
    })
    expect(byId(snap, "m2-new")).toBeDefined()
    expect(byId(snap, "m2-new")!.source).toBe("remote-discovered")
  })

  it("user-curated takes precedence over everything", () => {
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      modelsDevModels: [{ id: "m1", name: "from models.dev", contextLength: 200000 }],
      userCuratedModels: [{ id: "m1", name: "user override", contextLength: 99 }],
    })
    const m1 = byId(snap, "m1")!
    expect(m1.name).toBe("user override")
    expect(m1.contextLength).toBe(99)
  })

  it("merges cache pricing fields without dropping models.dev values", () => {
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      modelsDevModels: [
        {
          id: "m1",
          pricing: { promptPer1M: 3, completionPer1M: 15, cachedInputPer1M: 0.3 },
        },
      ],
      remoteModels: [{ id: "m1" }],
    })
    expect(byId(snap, "m1")!.pricing).toMatchObject({
      promptPer1M: 3,
      completionPer1M: 15,
      cachedInputPer1M: 0.3,
    })
  })

  it("does not present an unknown price as free and can complete partial pricing from another layer", () => {
    const partial = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      catalogModels: [{ id: "m", pricing: { promptPer1M: 3 } }],
    })
    expect(byId(partial, "m")!.pricing).toBeUndefined()
    const completed = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      catalogModels: [{ id: "m", pricing: { promptPer1M: 3, cachedInputPer1M: 1 } }],
      remoteModels: [{ id: "m", pricing: { completionPer1M: 0 } }],
    })
    expect(byId(completed, "m")!.pricing).toMatchObject({
      promptPer1M: 3,
      completionPer1M: 0,
      cachedInputPer1M: 1,
    })
  })

  it("fills unknown static metadata before applying display defaults", () => {
    const snapshot = buildProviderModelDiscoverySnapshot({
      providerId: "plugin:models",
      catalogModels: [{ id: "m" }],
      remoteModels: [
        {
          id: "m",
          name: "Real",
          contextLength: 256000,
          supportsTools: false,
          supportsVision: true,
        },
      ],
    })
    expect(byId(snapshot, "m")).toMatchObject({
      name: "Real",
      contextLength: 256000,
      supportsTools: false,
      supportsVision: true,
    })
    expect(byId(snapshot, "m")!.knownFields).toEqual(
      expect.arrayContaining(["name", "contextLength", "supportsTools", "supportsVision"])
    )
    expect(byId(snapshot, "m")!.knownFields).not.toContain("supportsAudio")
  })

  it("marks only supplied metadata as known despite ModelConfig compatibility defaults", () => {
    const snapshot = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      catalogModels: [{ id: "m" }],
      remoteModels: [{ id: "m", supportsVision: false }],
    })
    expect(byId(snapshot, "m")!.knownFields).toEqual(["id", "supportsVision"])
    expect(byId(snapshot, "m")!.supportsTools).toBe(true)
    expect(byId(snapshot, "m")!.knownFields).not.toContain("supportsTools")
  })

  it("retains explicit false and zero in higher-authority catalog metadata", () => {
    const snapshot = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      catalogModels: [{ id: "m", contextLength: 0, supportsVision: false }],
      remoteModels: [{ id: "m", contextLength: 200, supportsVision: true }],
    })
    expect(byId(snapshot, "m")).toMatchObject({ contextLength: 0, supportsVision: false })
  })

  it("uses explicit account metadata over subscription defaults while retaining unknown fields", () => {
    const snapshot = buildProviderModelDiscoverySnapshot({
      providerId: "plugin:models",
      remoteOverridesCatalog: true,
      catalogModels: [
        {
          id: "m",
          name: "Default",
          contextLength: 1000000,
          supportsVision: true,
          supportsTools: true,
        },
      ],
      remoteModels: [{ id: "m", name: "Account", contextLength: 256000, supportsVision: false }],
    })
    expect(byId(snapshot, "m")).toMatchObject({
      name: "Account",
      contextLength: 256000,
      supportsVision: false,
      supportsTools: true,
      source: "remote-discovered",
    })
  })
})

describe("provider model wire metadata", () => {
  it("forwards cancellation and bearer credentials for compatible list requests", async () => {
    const signal = new AbortController().signal
    jest.mocked(proxyFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: "kimi", context_length: 262144, supports_reasoning: true }],
      }),
    } as Response)
    const models = await discoverOpenAICompatibleModels({
      baseURL: "https://api.example/coding/v1",
      apiKey: "example-key",
      signal,
    })
    expect(proxyFetch).toHaveBeenCalledWith(
      "https://api.example/coding/v1/models",
      expect.objectContaining({
        signal,
        headers: expect.objectContaining({ Authorization: "Bearer example-key" }),
      })
    )
    expect(models[0]).toMatchObject({ contextLength: 262144, supportsReasoning: true })
  })

  it("keeps absent capability fields unknown", () => {
    const model = parseProviderModelWire({ id: "m" })
    expect(model.supportsTools).toBeUndefined()
    expect(model.supportsVision).toBeUndefined()
    expect(model.supportsStreaming).toBeUndefined()
    expect(model.maxOutputTokens).toBeUndefined()
  })

  it("reads the official Kimi image/video fields without inventing an output limit", () => {
    const model = parseProviderModelWire({
      id: "kimi-for-coding",
      display_name: "Kimi",
      context_length: 1048576,
      supports_reasoning: true,
      supports_image_in: false,
      supports_video_in: true,
    })
    expect(model).toMatchObject({
      name: "Kimi",
      contextLength: 1048576,
      supportsReasoning: true,
      supportsVision: false,
      supportsVideo: true,
    })
    expect(model.maxOutputTokens).toBeUndefined()
  })

  it.each(["max_output_tokens", "max_tokens", "output_token_limit", "outputTokenLimit"])(
    "reads the explicit %s output limit",
    (field) => {
      expect(parseProviderModelWire({ id: "m", [field]: 64000 })).toMatchObject({
        maxOutputTokens: 64000,
      })
      expect(parseProviderModelWire({ id: "m", [field]: 0 })).toMatchObject({ maxOutputTokens: 0 })
    }
  )

  it.each(["max_input_tokens", "input_token_limit", "inputTokenLimit"])(
    "retains independent context and %s input limits",
    (field) => {
      const model = parseProviderModelWire({
        id: "m",
        context_length: 200000,
        [field]: 150000,
        max_output_tokens: 50000,
      })
      expect(model).toMatchObject({
        contextLength: 200000,
        maxInputTokens: 150000,
        maxOutputTokens: 50000,
      })
      const snapshot = buildProviderModelDiscoverySnapshot({
        providerId: "p",
        remoteModels: [model],
      })
      expect(byId(snapshot, "m")!.knownFields).toEqual(
        expect.arrayContaining(["contextLength", "maxInputTokens", "maxOutputTokens"])
      )
      expect(modelConfigToProviderModelCandidate(byId(snapshot, "m")!)).toMatchObject({
        maxInputTokens: 150000,
        maxOutputTokens: 50000,
      })
    }
  )

  it("parses Kimi metadata and Anthropic documented capabilities without losing false/zero", () => {
    expect(
      parseProviderModelWire({
        id: "kimi",
        name: "Kimi",
        context_length: 0,
        max_output_tokens: 0,
        supports_reasoning: false,
        supports_video: true,
      })
    ).toMatchObject({
      name: "Kimi",
      contextLength: 0,
      maxOutputTokens: 0,
      supportsReasoning: false,
      supportsVideo: true,
    })
    expect(
      parseProviderModelWire({
        id: "claude",
        display_name: "Claude",
        max_input_tokens: 200000,
        max_tokens: 64000,
        capabilities: { image_input: { supported: false }, thinking: { supported: true } },
      })
    ).toMatchObject({
      name: "Claude",
      contextLength: 200000,
      maxOutputTokens: 64000,
      supportsVision: false,
      supportsReasoning: true,
    })
  })

  it.each([
    null,
    [],
    {},
    { id: "" },
    { id: "m", context_length: -1 },
    { id: "m", context_length: "200" },
    { id: "m", supports_vision: "false" },
  ])("rejects malformed models %j", (model) => {
    expect(() => parseProviderModelWire(model)).toThrow()
  })

  it.each([null, {}, { data: {} }, { data: [{ name: "no id" }] }])(
    "rejects malformed lists %j",
    (payload) => {
      expect(() => parseProviderModelsWire(payload)).toThrow()
    }
  )
})

describe("custom subscription metadata", () => {
  it("retains canonical capabilities and legacy aliases without default overwrites", () => {
    const snapshot = buildCustomProviderModelDiscoverySnapshot({
      providerId: "custom",
      provider: {
        customModels: ["m"],
        customModelMetadata: {
          m: {
            name: "M",
            supportsVision: false,
            supportsReasoning: true,
            supportsStructuredOutput: true,
            capabilities: { vision: true, functionCalling: false },
            pricing: { promptPer1M: 0, completionPer1M: 1, cachedInputPer1M: 0.1, currency: "USD" },
          },
        },
      },
    })
    expect(byId(snapshot, "m")).toMatchObject({
      supportsVision: false,
      supportsTools: false,
      supportsReasoning: true,
      supportsStructuredOutput: true,
    })
    expect(modelConfigToProviderModelCandidate(byId(snapshot, "m")!)).toMatchObject({
      supportsStructuredOutput: true,
      pricing: { promptPer1M: 0, cachedInputPer1M: 0.1, currency: "USD" },
    })
  })
})

describe("buildBuiltInProviderModelDiscoverySnapshot", () => {
  it("threads models.dev models into the merge", () => {
    const snap = buildBuiltInProviderModelDiscoverySnapshot({
      providerId: "anthropic",
      catalogModels: [{ id: "m1", contextLength: 8000 }],
      modelsDevModels: [{ id: "m1", contextLength: 200000 }],
      settings: { discoveredModels: [{ id: "m2" }], discoveredModelsLastFetched: 5 },
    })
    expect(byId(snap, "m1")!.contextLength).toBe(200000)
    expect(byId(snap, "m2")).toBeDefined()
  })
})
