import {
  getProviderAdapter,
  resolveBuiltInProviderAdapter,
  resolveCustomProviderAdapter,
} from "./provider-adapters"

describe("getProviderAdapter", () => {
  it("returns known adapter definitions by id", () => {
    expect(getProviderAdapter("anthropic")).toMatchObject({
      family: "anthropic-native",
      protocol: "anthropic",
    })
    expect(getProviderAdapter(undefined)).toBeUndefined()
  })
})

describe("resolveBuiltInProviderAdapter", () => {
  it("maps native, local, proxy, and OpenRouter providers to their adapter families", () => {
    expect(resolveBuiltInProviderAdapter("anthropic")).toMatchObject({ id: "anthropic" })
    expect(resolveBuiltInProviderAdapter("ollama")).toMatchObject({
      id: "local-openai-compatible",
      builtInDefaults: { requiresCredential: false, requiresBaseUrl: true, isLocal: true },
    })
    expect(resolveBuiltInProviderAdapter("cliproxyapi")).toMatchObject({ id: "cliproxyapi" })
    expect(resolveBuiltInProviderAdapter("openrouter")).toMatchObject({ id: "openrouter" })
  })
})

describe("resolveCustomProviderAdapter", () => {
  it("uses explicit custom protocols and falls back unknown plugin protocols to OpenAI-compatible defaults", () => {
    expect(
      resolveCustomProviderAdapter("custom-anthropic", { apiProtocol: "anthropic" })
    ).toMatchObject({
      id: "anthropic",
    })
    expect(
      resolveCustomProviderAdapter("custom-plugin", {
        apiProtocol: "plugin:adapter",
      })
    ).toMatchObject({ id: "openai-compatible" })
  })

  it("reuses a compatible built-in adapter when the custom provider matches a known catalog entry", () => {
    expect(
      resolveCustomProviderAdapter("custom-modelscope", {
        customName: "ModelScope",
        baseURL: "https://api-inference.modelscope.cn/v1",
        apiProtocol: "openai",
      })
    ).toMatchObject({
      id: "openai-compatible",
      builtInDefaults: { requiresCredential: true, requiresBaseUrl: false, isLocal: false },
    })
  })
})
