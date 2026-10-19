import {
  normalizeBuiltInProviderConfig,
  normalizeCustomProviderConfig,
} from "./provider-normalization"

describe("normalizeBuiltInProviderConfig", () => {
  it("selects the active API key and applies catalog defaults", () => {
    expect(
      normalizeBuiltInProviderConfig("openai", {
        apiKey: " fallback ",
        apiKeys: [" first ", " second "],
        currentKeyIndex: 1,
        enabled: true,
      })
    ).toMatchObject({
      providerId: "openai",
      source: "built-in",
      adapterId: "openai-compatible",
      apiKey: " second ",
      defaultModel: "gpt-6.1-sol",
      enabled: true,
      requiresCredential: true,
      requiresBaseUrl: false,
      isLocal: false,
    })
  })

  it("preserves a configured older model instead of migrating the user's pin", () => {
    const settings = { enabled: true, defaultModel: "gpt-5.6" }
    expect(normalizeBuiltInProviderConfig("openai", settings).defaultModel).toBe("gpt-5.6")
    expect(settings.defaultModel).toBe("gpt-5.6")
  })
})

describe("normalizeCustomProviderConfig", () => {
  it("trims optional base URLs and reports equivalent built-in matches", () => {
    expect(
      normalizeCustomProviderConfig("custom-modelscope", {
        apiKey: " custom ",
        baseURL: " https://api-inference.modelscope.cn/v1/ ",
        customName: "ModelScope",
        apiProtocol: "openai",
        enabled: true,
      })
    ).toMatchObject({
      providerId: "custom-modelscope",
      source: "custom",
      adapterId: "openai-compatible",
      apiKey: "custom",
      baseURL: "https://api-inference.modelscope.cn/v1/",
      enabled: true,
      requiresCredential: true,
      requiresBaseUrl: true,
      isLocal: false,
      equivalentBuiltInProviderId: "modelscope",
    })
  })
})
