import {
  collectModelOptions,
  catalogModelIds,
  resolveModelDisplayName,
  resolveModelContextLength,
} from "./model-options"
import { PROVIDERS } from "@/types/provider/provider"
import type { UserProviderSettings, CustomProviderSettings } from "@/types/provider/provider"

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

  it("populates the human-readable provider name + model name for built-ins", () => {
    const out = collectModelOptions(undefined, undefined)
    const anthropic = out.find((o) => o.providerId === "anthropic")
    expect(anthropic?.providerName).toBe(PROVIDERS.anthropic.name)
    expect(anthropic?.providerName).not.toBe("anthropic") // no longer the raw id
    // The default model id resolves to its catalog display name.
    const defModel = PROVIDERS.anthropic.models.find(
      (m) => m.id === PROVIDERS.anthropic.defaultModel
    )
    if (defModel) {
      const opt = out.find((o) => o.modelId === defModel.id)
      expect(opt?.modelName).toBe(defModel.name)
    }
  })
})

describe("resolveModelDisplayName", () => {
  it("prefers custom-provider metadata names", () => {
    const customs: CustomProviderSettings[] = [
      {
        id: "cp",
        customModelMetadata: { m1: { id: "m1", name: "My Model" } },
      } as unknown as CustomProviderSettings,
    ]
    expect(resolveModelDisplayName("cp", "m1", undefined, customs)).toBe("My Model")
  })

  it("uses the built-in catalog name for a known model", () => {
    const m = PROVIDERS.anthropic.models[0]
    expect(resolveModelDisplayName("anthropic", m.id)).toBe(m.name)
  })

  it("uses a discovered model's name when present", () => {
    const settings: Record<string, UserProviderSettings> = {
      openai: { discoveredModels: [{ id: "x-1", name: "X One" }] } as never,
    }
    expect(resolveModelDisplayName("openai", "x-1", settings)).toBe("X One")
  })

  it("falls back to the alias table then the raw id", () => {
    // gpt-4o is in the alias table even for an unknown provider scope.
    expect(resolveModelDisplayName("mystery", "gpt-4o")).toBe("GPT-4o")
    expect(resolveModelDisplayName(undefined, "totally-unknown-xyz")).toBe("totally-unknown-xyz")
  })
})

describe("resolveModelContextLength", () => {
  it("reads an explicit custom-model context length", () => {
    const customs: CustomProviderSettings[] = [
      {
        id: "cp",
        customModelMetadata: { m1: { id: "m1", contextLength: 32_000 } },
      } as unknown as CustomProviderSettings,
    ]
    expect(resolveModelContextLength("m1", "cp", undefined, customs)).toBe(32_000)
  })

  it("reads a discovered model's context length", () => {
    const settings: Record<string, UserProviderSettings> = {
      openai: { discoveredModels: [{ id: "x-1", contextLength: 128_000 }] } as never,
    }
    expect(resolveModelContextLength("x-1", "openai", settings)).toBe(128_000)
  })

  it("returns undefined for built-in models so the pattern table wins", () => {
    expect(resolveModelContextLength("claude-sonnet-4-6", "anthropic")).toBeUndefined()
  })

  it("returns undefined without a provider id or for non-positive lengths", () => {
    expect(resolveModelContextLength("m1", undefined)).toBeUndefined()
    const customs: CustomProviderSettings[] = [
      {
        id: "cp",
        customModelMetadata: { m1: { id: "m1", contextLength: 0 } },
      } as unknown as CustomProviderSettings,
    ]
    expect(resolveModelContextLength("m1", "cp", undefined, customs)).toBeUndefined()
  })
})
