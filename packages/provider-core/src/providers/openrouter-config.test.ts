import { BYOK_PROVIDERS, getConfigHelp, getConfigPlaceholder } from "./openrouter-config"

describe("BYOK_PROVIDERS", () => {
  it("separates simple provider keys from complex cloud credential configs", () => {
    expect(BYOK_PROVIDERS.find((provider) => provider.id === "openai")).toMatchObject({
      configType: "simple",
    })
    expect(BYOK_PROVIDERS.find((provider) => provider.id === "azure")).toMatchObject({
      configType: "azure",
    })
    expect(BYOK_PROVIDERS.find((provider) => provider.id === "bedrock")).toMatchObject({
      configType: "bedrock",
    })
    expect(BYOK_PROVIDERS.find((provider) => provider.id === "vertex")).toMatchObject({
      configType: "vertex",
    })
  })
})

describe("getConfigPlaceholder", () => {
  it("returns complex JSON examples only for providers that need them", () => {
    expect(getConfigPlaceholder("azure")).toContain("endpoint_url")
    expect(getConfigPlaceholder("bedrock")).toContain("accessKeyId")
    expect(getConfigPlaceholder("vertex")).toContain("service_account")
    expect(getConfigPlaceholder("simple")).toBe("")
  })
})

describe("getConfigHelp", () => {
  it("describes each complex BYOK config type", () => {
    expect(getConfigHelp("azure")).toContain("Azure")
    expect(getConfigHelp("bedrock")).toContain("Bedrock")
    expect(getConfigHelp("vertex")).toContain("Google Cloud")
    expect(getConfigHelp()).toBe("")
  })
})
