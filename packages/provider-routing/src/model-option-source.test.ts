// Coverage for the shared provider+model option source (extracted from
// default-model-picker; that component's test still exercises it indirectly).

import {
  catalogModelIds,
  collectOptions,
  customProviderModelIds,
  groupByProvider,
} from "./model-option-source"
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

describe("regression: the option universe a picker and the router share", () => {
  it("surfaces a built-in provider's whole configured set, not just its default", () => {
    // `components/inbox/provider-model-switcher.tsx` collected against an
    // invented shape (`cfg.models`) that does not exist on
    // `UserProviderSettings`, so the IM switcher and the bot default-model
    // dropdown offered exactly one model per built-in provider.
    const options = collectOptions(
      {
        openai: {
          providerId: "openai",
          enabled: true,
          defaultModel: "gpt-4.1",
          enabledModels: ["gpt-5.4", "gpt-5.4-mini"],
          discoveredModels: [{ id: "o4-mini" }],
        } as never,
      },
      undefined
    )
    const ids = options.filter((o) => o.providerId === "openai").map((o) => o.modelId)
    expect(ids).toEqual(expect.arrayContaining(["gpt-4.1", "gpt-5.4", "gpt-5.4-mini", "o4-mini"]))
    expect(ids).toHaveLength(4)
  })

  it("includes a custom provider's models when it has no defaultModel", () => {
    // Failed in BOTH surviving collectors: they read `models` as `{id}`
    // objects, so a `string[]` always resolved `undefined`.
    const options = collectOptions(undefined, [
      {
        id: "local",
        enabled: true,
        name: "Local",
        customModels: ["a", "b"],
        models: ["a", "b"],
      } as never,
    ])
    const ids = options.filter((o) => o.providerId === "local").map((o) => o.modelId)
    expect(ids.sort()).toEqual(["a", "b"])
  })

  it("dedupes across customModels, models and defaultModel", () => {
    const ids = customProviderModelIds({
      id: "local",
      defaultModel: "a",
      customModels: ["a", "b"],
      models: ["b", "c"],
    } as never)
    expect(ids.sort()).toEqual(["a", "b", "c"])
  })

  it("tolerates an object-shaped entry without letting it become undefined", () => {
    const ids = customProviderModelIds({
      id: "local",
      customModels: [{ id: "obj" } as never],
    } as never)
    expect(ids).toEqual(["obj"])
  })
})
