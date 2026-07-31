// Coverage for the shared provider+model option source (extracted from
// default-model-picker; that component's test still exercises it indirectly).

import { catalogModelIds, collectOptions, groupByProvider } from "./model-option-source"
import type { UserProviderSettings, CustomProviderSettings } from "@cognia/provider-types/provider"

const ps = (over: Partial<UserProviderSettings> = {}): UserProviderSettings =>
  ({ providerId: "openai", enabled: true, defaultModel: "", ...over }) as UserProviderSettings

describe("catalogModelIds", () => {
  it("returns the curated catalog for a known provider", () => {
    const ids = catalogModelIds("openai")
    expect(ids.length).toBeGreaterThan(0)
  })

  it("returns [] for an unknown provider", () => {
    expect(catalogModelIds("not-a-provider")).toEqual([])
  })
})

describe("collectOptions", () => {
  it("always includes anthropic even without a providerSettings entry", () => {
    const out = collectOptions({}, undefined)
    expect(out.some((o) => o.providerId === "anthropic")).toBe(true)
  })

  it("respects an explicit anthropic opt-out", () => {
    const out = collectOptions(
      { anthropic: ps({ providerId: "anthropic", enabled: false }) },
      undefined
    )
    expect(out.some((o) => o.providerId === "anthropic")).toBe(false)
  })

  it("unions defaultModel, enabledModels, and discoveredModels", () => {
    const out = collectOptions(
      {
        openai: ps({
          defaultModel: "gpt-4o",
          enabledModels: ["gpt-4o-mini"],
          discoveredModels: [{ id: "o1" }] as UserProviderSettings["discoveredModels"],
        }),
      },
      undefined
    )
    const models = out.filter((o) => o.providerId === "openai").map((o) => o.modelId)
    expect(models).toEqual(expect.arrayContaining(["gpt-4o", "gpt-4o-mini", "o1"]))
  })

  it("falls back to the curated catalog when nothing is configured", () => {
    const out = collectOptions({ openai: ps({ defaultModel: "" }) }, undefined)
    expect(out.filter((o) => o.providerId === "openai").length).toBeGreaterThan(0)
  })

  it("skips disabled providers and includes enabled custom providers", () => {
    const custom = [
      {
        id: "my-local",
        name: "My Local",
        enabled: true,
        defaultModel: "llama3",
        models: [{ id: "qwen3" }],
      } as unknown as CustomProviderSettings,
      { id: "off", name: "Off", enabled: false } as unknown as CustomProviderSettings,
    ]
    const out = collectOptions({ openai: ps({ enabled: false }) }, custom)
    expect(out.some((o) => o.providerId === "openai")).toBe(false)
    const local = out.filter((o) => o.providerId === "my-local")
    expect(local.map((o) => o.modelId)).toEqual(expect.arrayContaining(["llama3", "qwen3"]))
    expect(local[0]?.providerName).toBe("My Local")
    expect(out.some((o) => o.providerId === "off")).toBe(false)
  })
})

describe("groupByProvider", () => {
  it("groups options by provider and dedupes models", () => {
    const groups = groupByProvider([
      { providerId: "a", providerName: "A", modelId: "m1" },
      { providerId: "a", providerName: "A", modelId: "m1" },
      { providerId: "a", providerName: "A", modelId: "m2" },
      { providerId: "b", providerName: "B", modelId: "m3" },
    ])
    expect(groups).toEqual([
      { providerId: "a", providerName: "A", models: ["m1", "m2"] },
      { providerId: "b", providerName: "B", models: ["m3"] },
    ])
  })
})
