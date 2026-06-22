import {
  BUILTIN_API_PROTOCOLS,
  PROVIDERS,
  getAllProviders,
  getModelConfig,
  getProviderConfig,
} from "./provider"

describe("provider catalog fallback", () => {
  it("returns built-in provider and model configs", () => {
    expect(getProviderConfig("openai")).toBe(PROVIDERS.openai)
    expect(getProviderConfig("missing")).toBeUndefined()
    expect(getModelConfig("openai", "gpt-4.1")).toMatchObject({
      id: "gpt-4.1",
      supportsTools: true,
    })
    expect(getModelConfig("openai", "missing")).toBeUndefined()
  })

  it("exposes built-in API protocols and merges dynamic providers", () => {
    expect(BUILTIN_API_PROTOCOLS).toEqual(["openai", "anthropic", "gemini"])
    expect(getAllProviders().openai).toBe(PROVIDERS.openai)
  })
})
