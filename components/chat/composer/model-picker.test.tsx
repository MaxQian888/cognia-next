import { __testing__ } from "./model-picker"
import type { UserProviderSettings, CustomProviderSettings } from "@/types/provider/provider"

const { collectModelOptions, groupByProvider } = __testing__

describe("collectModelOptions", () => {
  it("returns an empty list when nothing is configured", () => {
    expect(collectModelOptions(undefined, undefined)).toEqual([])
  })

  it("skips disabled built-in providers", () => {
    const providerSettings: Record<string, UserProviderSettings> = {
      openai: {
        enabled: false,
        defaultModel: "gpt-4o",
      } as unknown as UserProviderSettings,
      anthropic: {
        enabled: true,
        defaultModel: "claude-3-5-sonnet",
      } as unknown as UserProviderSettings,
    }
    const opts = collectModelOptions(providerSettings, undefined)
    expect(opts.map((o) => o.providerId)).toEqual(["anthropic"])
  })

  it("includes the defaultModel even when no whitelist is set", () => {
    const providerSettings: Record<string, UserProviderSettings> = {
      anthropic: {
        enabled: true,
        defaultModel: "claude-3-5-sonnet",
      } as unknown as UserProviderSettings,
    }
    const opts = collectModelOptions(providerSettings, undefined)
    expect(opts).toEqual([
      { providerId: "anthropic", providerName: "anthropic", modelId: "claude-3-5-sonnet" },
    ])
  })

  it("merges enabledModels and discoveredModels without duplicates", () => {
    const providerSettings: Record<string, UserProviderSettings> = {
      openai: {
        enabled: true,
        defaultModel: "gpt-4o-mini",
        enabledModels: ["gpt-4o", "gpt-4o-mini"],
        discoveredModels: [
          { id: "gpt-4o-mini" }, // duplicate of enabledModels
          { id: "o1-preview" }, // unique
        ],
      } as unknown as UserProviderSettings,
    }
    const opts = collectModelOptions(providerSettings, undefined)
    const ids = opts.map((o) => o.modelId).sort()
    expect(ids).toEqual(["gpt-4o", "gpt-4o-mini", "o1-preview"])
  })

  it("includes custom providers after built-ins", () => {
    const providerSettings: Record<string, UserProviderSettings> = {
      anthropic: {
        enabled: true,
        defaultModel: "claude-3-5-sonnet",
      } as unknown as UserProviderSettings,
    }
    const customProviders: CustomProviderSettings[] = [
      {
        id: "self-hosted",
        name: "My Server",
        enabled: true,
        defaultModel: "llama-3.3-70b",
        models: [{ id: "llama-3.3-70b" }, { id: "qwen2.5-32b" }],
      } as unknown as CustomProviderSettings,
    ]
    const opts = collectModelOptions(providerSettings, customProviders)
    expect(opts.find((o) => o.providerId === "anthropic")).toBeDefined()
    const customs = opts.filter((o) => o.providerId === "self-hosted")
    expect(customs.map((o) => o.modelId).sort()).toEqual(["llama-3.3-70b", "qwen2.5-32b"])
    expect(customs[0].providerName).toBe("My Server")
  })

  it("skips disabled custom providers", () => {
    const customProviders: CustomProviderSettings[] = [
      {
        id: "self-hosted",
        name: "My Server",
        enabled: false,
        defaultModel: "llama-3.3-70b",
      } as unknown as CustomProviderSettings,
    ]
    const opts = collectModelOptions(undefined, customProviders)
    expect(opts).toEqual([])
  })

  it("falls back to provider id when custom provider has no name", () => {
    const customProviders: CustomProviderSettings[] = [
      {
        id: "raw-id",
        enabled: true,
        defaultModel: "x",
      } as unknown as CustomProviderSettings,
    ]
    const opts = collectModelOptions(undefined, customProviders)
    expect(opts[0].providerName).toBe("raw-id")
  })
})

describe("groupByProvider", () => {
  it("returns an empty list for no options", () => {
    expect(groupByProvider([])).toEqual([])
  })

  it("preserves insertion order across providers and models", () => {
    const groups = groupByProvider([
      { providerId: "anthropic", providerName: "anthropic", modelId: "claude-3-5-sonnet" },
      { providerId: "openai", providerName: "openai", modelId: "gpt-4o" },
      { providerId: "anthropic", providerName: "anthropic", modelId: "claude-3-5-haiku" },
      { providerId: "openai", providerName: "openai", modelId: "gpt-4o-mini" },
    ])
    expect(groups.map((g) => g.providerId)).toEqual(["anthropic", "openai"])
    expect(groups[0].models).toEqual(["claude-3-5-sonnet", "claude-3-5-haiku"])
    expect(groups[1].models).toEqual(["gpt-4o", "gpt-4o-mini"])
  })

  it("dedupes duplicate models within the same provider", () => {
    const groups = groupByProvider([
      { providerId: "openai", providerName: "openai", modelId: "gpt-4o" },
      { providerId: "openai", providerName: "openai", modelId: "gpt-4o" },
    ])
    expect(groups[0].models).toEqual(["gpt-4o"])
  })
})
