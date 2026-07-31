import {
  buildBuiltInSettingsFromCustomProvider,
  findEquivalentBuiltInProviderCandidates,
  resolveEquivalentBuiltInProviderId,
} from "./built-in-provider-compatibility"

describe("resolveEquivalentBuiltInProviderId", () => {
  it("matches quick-add compatible providers by normalized base URL and name hint", () => {
    expect(
      resolveEquivalentBuiltInProviderId({
        customName: "ModelScope gateway",
        baseURL: "https://api-inference.modelscope.cn/v1/",
        apiProtocol: "openai",
      })
    ).toBe("modelscope")
  })

  it("does not match when protocol differs even if the base URL is known", () => {
    expect(
      resolveEquivalentBuiltInProviderId({
        customName: "ModelScope gateway",
        baseURL: "https://api-inference.modelscope.cn/v1",
        apiProtocol: "anthropic",
      })
    ).toBeUndefined()
  })
})

describe("findEquivalentBuiltInProviderCandidates", () => {
  it("keeps the first custom provider candidate for each built-in provider", () => {
    const candidates = findEquivalentBuiltInProviderCandidates({
      first: {
        customName: "ModelScope primary",
        baseURL: "https://api-inference.modelscope.cn/v1",
        apiProtocol: "openai",
      },
      second: {
        customName: "ModelScope secondary",
        baseURL: "https://api-inference.modelscope.cn/v1",
        apiProtocol: "openai",
      },
    })

    expect(candidates.modelscope).toMatchObject({
      builtInProviderId: "modelscope",
      customProviderId: "first",
    })
  })
})

describe("buildBuiltInSettingsFromCustomProvider", () => {
  it("projects custom credentials and falls back to the built-in model when the custom default is invalid", () => {
    const settings = buildBuiltInSettingsFromCustomProvider("modelscope", {
      apiKey: "  ms-key  ",
      enabled: true,
      defaultModel: "unknown-model",
      discoveredModels: [{ id: "Qwen/Qwen3-235B-A22B-Instruct-2507" }],
      discoveredModelsLastFetched: 123,
    })

    expect(settings).toMatchObject({
      providerId: "modelscope",
      apiKey: "ms-key",
      enabled: true,
      defaultModel: "Qwen/Qwen3-235B-A22B-Instruct-2507",
      discoveredModelsLastFetched: 123,
      verificationStatus: "unverified",
    })
    expect(settings.discoveredModels).toEqual([{ id: "Qwen/Qwen3-235B-A22B-Instruct-2507" }])
  })
})
