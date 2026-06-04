import { collectModelOptions, catalogModelIds } from "./model-options"

describe("catalogModelIds", () => {
  it("returns an empty list for an unknown provider", () => {
    expect(catalogModelIds("not-a-provider")).toEqual([])
  })

  it("includes the provider's default model", () => {
    const ids = catalogModelIds("anthropic")
    expect(ids.length).toBeGreaterThan(0)
  })
})

describe("collectModelOptions", () => {
  it("always includes anthropic with its curated catalog when unconfigured", () => {
    const out = collectModelOptions(undefined, undefined)
    expect(out.some((o) => o.providerId === "anthropic")).toBe(true)
  })

  it("respects enabled:false and prefers configured models over catalog", () => {
    const out = collectModelOptions(
      {
        anthropic: { providerId: "anthropic", enabled: false } as never,
        deepseek: { providerId: "deepseek", enabledModels: ["deepseek-chat"] } as never,
      },
      undefined
    )
    expect(out.some((o) => o.providerId === "anthropic")).toBe(false)
    expect(out).toContainEqual(
      expect.objectContaining({ providerId: "deepseek", modelId: "deepseek-chat" })
    )
  })

  it("appends enabled custom providers after the built-ins", () => {
    const out = collectModelOptions(undefined, [
      {
        id: "local",
        name: "Local",
        enabled: true,
        defaultModel: "llama3",
        models: [{ id: "llama3" }, { id: "qwen3" }, {}],
      } as never,
      { id: "off", name: "Off", enabled: false, defaultModel: "x" } as never,
    ])
    expect(out).toContainEqual(expect.objectContaining({ providerId: "local", modelId: "qwen3" }))
    expect(out).toContainEqual(
      expect.objectContaining({ providerId: "local", providerName: "Local", modelId: "llama3" })
    )
    expect(out.some((o) => o.providerId === "off")).toBe(false)
  })

  it("merges discoveredModels into the allowed set", () => {
    const out = collectModelOptions(
      {
        deepseek: {
          providerId: "deepseek",
          discoveredModels: [{ id: "deepseek-reasoner" }],
        } as never,
      },
      undefined
    )
    expect(out).toContainEqual(expect.objectContaining({ modelId: "deepseek-reasoner" }))
  })
})
