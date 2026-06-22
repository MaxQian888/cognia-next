import {
  buildProviderStateProjectionMap,
  buildProviderStateProjections,
  getProviderSelectionGuidance,
} from "./projection"

describe("provider state projections", () => {
  it("builds selectable built-in provider projections with model metadata", () => {
    const projections = buildProviderStateProjectionMap({
      providerSettings: {
        openai: {
          enabled: true,
          apiKey: "sk-test",
          defaultModel: "gpt-4o",
        },
      },
      builtInTestResults: { openai: { success: true } },
    })

    expect(projections.openai).toMatchObject({
      id: "openai",
      kind: "built-in",
      enabled: true,
      selectable: true,
      hasCredential: true,
    })
    expect(projections.openai.models.length).toBeGreaterThan(0)
    expect(projections.openai.defaultModelId).toBeTruthy()
  })

  it("builds custom provider projections and exposes first remediation guidance", () => {
    const projections = buildProviderStateProjections({
      providerSettings: {},
      customProviders: {
        customA: {
          customName: "Custom A",
          baseURL: "https://api.example.com/v1",
          enabled: true,
          defaultModel: "model-a",
          customModels: ["model-a"],
        },
      },
    })

    expect(projections[0]).toMatchObject({
      id: "customA",
      kind: "custom",
      displayName: "Custom A",
      selectable: false,
      hasCredential: false,
    })
    expect(getProviderSelectionGuidance(projections)).toBeTruthy()
  })

  it("falls back to available models when enabled model ids do not match", () => {
    const projections = buildProviderStateProjectionMap({
      providerSettings: {
        openai: {
          enabled: false,
          apiKey: "sk-test",
          defaultModel: "not-installed",
          enabledModels: ["not-installed"],
        },
      },
    })

    expect(projections.openai.enabled).toBe(false)
    expect(projections.openai.enabledModels).toHaveLength(projections.openai.models.length)
    expect(projections.openai.defaultModelId).not.toBe("not-installed")
    expect(projections.openai.modelIds).toContain(projections.openai.defaultModelId)
    expect(projections.openai.defaultModel).toEqual(
      expect.objectContaining({ id: projections.openai.defaultModelId })
    )
  })

  it("keeps valid enabled model subsets and derives model capabilities", () => {
    const projections = buildProviderStateProjectionMap({
      providerSettings: {
        openai: {
          enabled: true,
          apiKey: "sk-test",
          defaultModel: "gpt-4o",
          enabledModels: ["gpt-4o"],
        },
      },
      builtInTestResults: { openai: { success: true } },
    })

    expect(projections.openai.enabledModelIds).toEqual(["gpt-4o"])
    expect(projections.openai.metadata.supportsStreaming).toBe(true)
    expect(projections.openai.metadata.supportsVision).toBe(true)
    expect(projections.openai.metadata.supportsTools).toBe(true)
    expect(projections.openai.metadata.maxTokens).toBeGreaterThan(0)
  })

  it("falls back for unknown built-in providers with manual defaults", () => {
    const projections = buildProviderStateProjectionMap({
      providerSettings: {
        "manual-provider": {
          enabled: true,
          apiKey: "sk-test",
          baseURL: "https://manual.example/v1",
          defaultModel: "manual-model",
        },
        "empty-provider": {
          enabled: true,
          apiKey: "sk-test",
          baseURL: "https://empty.example/v1",
        },
      },
      builtInTestResults: {
        "manual-provider": { success: true },
        "empty-provider": { success: true },
      },
    })

    expect(projections["manual-provider"]).toMatchObject({
      id: "manual-provider",
      kind: "built-in",
      displayName: "manual-provider",
      description: "Built-in provider",
      category: undefined,
      defaultModelId: "manual-model",
      defaultModel: undefined,
      selectable: true,
    })
    expect(projections["manual-provider"].metadata).toMatchObject({
      requiresApiKey: true,
      supportsStreaming: false,
      supportsVision: false,
      supportsTools: false,
      maxTokens: undefined,
    })
    expect(projections["empty-provider"].defaultModelId).toBe("")
    expect(projections["empty-provider"].settings).toEqual(
      expect.objectContaining({ baseURL: "https://empty.example/v1" })
    )
  })

  it("projects local built-in providers as local and selectable without credentials", () => {
    const projections = buildProviderStateProjectionMap({
      providerSettings: {
        ollama: {
          enabled: true,
          baseURL: "http://localhost:11434",
          defaultModel: "llama3",
        },
      },
      builtInTestResults: { ollama: { success: true } },
    })

    expect(projections.ollama).toMatchObject({
      id: "ollama",
      kind: "local",
      enabled: true,
      hasCredential: false,
      hasBaseUrl: true,
    })
    expect(projections.ollama.metadata.requiresApiKey).toBe(false)
  })

  it("normalizes custom provider test result variants and default display text", () => {
    const projections = buildProviderStateProjections({
      providerSettings: {},
      customProviders: {
        customSuccess: {
          apiKey: "key",
          baseURL: "https://success.example.com/v1",
          defaultModel: "m1",
          customModels: ["m1"],
        },
        customLimited: {
          apiKey: "key",
          baseURL: "https://limited.example.com/v1",
          defaultModel: "m2",
          customModels: ["m2"],
          apiProtocol: "openai",
        },
        customObject: {
          apiKey: "key",
          baseURL: "https://object.example.com/v1",
          defaultModel: "m3",
          customModels: ["m3"],
          enabled: false,
        },
        customError: {
          apiKey: "key",
          baseURL: "https://error.example.com/v1",
          defaultModel: "m4",
          customModels: ["m4"],
        },
      },
      customTestResults: {
        customSuccess: "success",
        customLimited: "limited",
        customObject: { success: true },
        customError: "error",
      },
    })

    const byId = Object.fromEntries(projections.map((projection) => [projection.id, projection]))

    expect(byId.customSuccess).toMatchObject({
      displayName: "customSuccess",
      description: "Custom provider",
      selectable: true,
      verificationStatus: "verified",
      enabled: true,
    })
    expect(byId.customLimited).toMatchObject({
      description: "Custom openai-compatible provider",
      readiness: "configured",
      selectable: true,
      verificationStatus: "unverified",
    })
    expect(byId.customObject).toMatchObject({
      blockedReason: "Enable this provider before using it at runtime.",
      selectable: false,
      enabled: false,
      nextAction: "enable_provider",
      settings: expect.objectContaining({ enabled: false }),
    })
    expect(byId.customError).toMatchObject({
      readiness: "configured",
      verificationStatus: "unverified",
      selectable: true,
    })
  })

  it("projects custom metadata, enabled subsets, and empty custom provider fallbacks", () => {
    const projections = buildProviderStateProjectionMap({
      providerSettings: {},
      customProviders: {
        customMeta: {
          apiKey: "key",
          baseURL: "https://meta.example.com/v1",
          defaultModel: "model-b",
          customModels: ["model-a", "model-b"],
          customModelMetadata: {
            "model-a": {
              contextLength: 4096,
              capabilities: { streaming: true },
            },
            "model-b": {
              name: "Model B",
              contextLength: 8192,
              capabilities: { vision: true, functionCalling: true },
            },
          },
          enabledModels: ["model-b"],
        } as never,
        customEmpty: undefined,
      },
      customTestResults: {
        customMeta: { success: true },
        customEmpty: null,
      },
    })

    expect(projections.customMeta).toMatchObject({
      displayName: "customMeta",
      defaultModelId: "model-b",
      enabledModelIds: ["model-b"],
      verificationStatus: "verified",
      selectable: true,
    })
    expect(projections.customMeta.metadata).toMatchObject({
      supportsStreaming: true,
      supportsVision: true,
      supportsTools: true,
      maxTokens: 8192,
    })
    expect(projections.customEmpty).toMatchObject({
      displayName: "customEmpty",
      description: "Custom provider",
      defaultModelId: "",
      settings: {},
      selectable: false,
    })
  })

  it("returns no provider selection guidance when all projections are selectable", () => {
    const projections = buildProviderStateProjections({
      providerSettings: {
        openai: {
          apiKey: "sk-test",
          defaultModel: "gpt-4o",
        },
      },
      builtInTestResults: { openai: { success: true } },
    })

    expect(getProviderSelectionGuidance(projections)).toBeUndefined()
  })
})
