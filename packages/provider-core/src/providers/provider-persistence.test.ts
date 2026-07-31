import {
  buildProviderSnapshotFromSettings,
  customSettingsToDefinitions,
  normalizeProviderPersistenceState,
  toProviderSettingsEntry,
  userSettingsMapToEntries,
} from "./provider-persistence"

describe("normalizeProviderPersistenceState", () => {
  it("hydrates built-in defaults, drops empty custom providers, and records equivalent built-ins", () => {
    const state = normalizeProviderPersistenceState({
      providerSettings: {
        openai: { apiKey: "sk", enabled: true, defaultModel: "gpt-4o" },
      },
      customProviders: {
        removed: undefined,
        ms: {
          customName: "ModelScope",
          baseURL: "https://api-inference.modelscope.cn/v1",
          apiProtocol: "openai",
        },
      },
    })

    expect(state.providerSettings.openai).toMatchObject({
      providerId: "openai",
      apiKey: "sk",
      defaultModel: "gpt-4o",
      enabled: true,
    })
    expect(Object.keys(state.customProviders)).toEqual(["ms"])
    expect(state.equivalentBuiltInProviders.modelscope?.customProviderId).toBe("ms")
  })
})

describe("provider settings projection", () => {
  it("maps rich settings into resolver entries", () => {
    expect(
      toProviderSettingsEntry({
        providerId: "openai",
        defaultModel: "gpt-4o",
        enabled: true,
        apiKey: "sk",
        baseURL: "https://api.example/v1",
        providerSpecificParams: { reasoningEffort: "medium" },
        advancedParams: { seed: 42 },
      })
    ).toEqual({
      enabled: true,
      apiKey: "sk",
      baseURL: "https://api.example/v1",
      defaultModel: "gpt-4o",
      options: { reasoningEffort: "medium", seed: 42 },
    })
  })

  it("maps full settings maps and custom providers into resolver snapshots", () => {
    expect(
      userSettingsMapToEntries({
        openai: { providerId: "openai", defaultModel: "gpt-4o", enabled: true, apiKey: "sk" },
      })
    ).toEqual({ openai: { enabled: true, apiKey: "sk", defaultModel: "gpt-4o" } })

    expect(
      customSettingsToDefinitions([
        {
          id: "custom-gemini",
          providerId: "custom-gemini",
          isCustom: true,
          customName: "Custom Gemini",
          name: "Custom Gemini",
          apiProtocol: "gemini",
          baseURL: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "key",
          defaultModel: "gemini-pro",
          enabled: true,
          customModels: ["gemini-pro"],
          models: ["gemini-pro"],
        },
      ])
    ).toEqual([
      {
        id: "custom-gemini",
        name: "Custom Gemini",
        protocol: "google",
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "key",
        defaultModel: "gemini-pro",
        models: [{ id: "gemini-pro" }],
      },
    ])

    expect(
      buildProviderSnapshotFromSettings({
        defaultProvider: "openai",
        providerSettings: { openai: { enabled: true } },
        customProviders: [{ id: "custom", protocol: "openai", baseURL: "https://example/v1" }],
      } as never)
    ).toEqual({
      defaultProvider: "openai",
      providerSettings: { openai: { enabled: true } },
      customProviders: [{ id: "custom", protocol: "openai", baseURL: "https://example/v1" }],
    })
  })
})
