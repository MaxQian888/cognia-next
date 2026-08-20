import type { ModelMapping } from "@cognia/provider-types/model-mapping"

import { CHEAP_TIER_ALIAS, cheapTierModelHint, resolveCheapTier } from "./cheap-tier"

const providerSettings = {
  openai: {
    providerId: "openai",
    enabled: true,
    defaultModel: "gpt-4.1",
    enabledModels: ["gpt-4o-mini", "gpt-4.1"],
  },
  anthropic: {
    providerId: "anthropic",
    enabled: true,
    enabledModels: ["claude-haiku-4-5-20251001", "claude-sonnet-5"],
  },
} as never

function mapping(over: Partial<ModelMapping> = {}): ModelMapping {
  return {
    id: "m1",
    alias: CHEAP_TIER_ALIAS,
    providers: [{ providerId: "openai", modelId: "gpt-4o-mini" }],
    distribution: "priority",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe("resolveCheapTier", () => {
  it("prefers an enabled fast alias so the existing engine resolves it", () => {
    // An alias re-enters ProviderRoutingEngine with every filter, strategy,
    // breaker and fallback chain intact — which is why there is no second
    // router in this feature.
    expect(resolveCheapTier({ modelMappings: [mapping()], providerSettings })).toEqual({
      kind: "alias",
      alias: "fast",
    })
  })

  it("matches the alias case-insensitively", () => {
    expect(
      resolveCheapTier({ modelMappings: [mapping({ alias: "Fast" })], providerSettings })
    ).toMatchObject({ kind: "alias" })
  })

  it("ignores a disabled alias", () => {
    expect(
      resolveCheapTier({ modelMappings: [mapping({ enabled: false })], providerSettings })
    ).toBeUndefined()
  })

  it("falls through an alias whose entries the user cannot serve", () => {
    // Handing the engine a chain it will reject with RoutingNoCandidatesError
    // is worse than admitting there is no cheap lane.
    const dead = mapping({ providers: [{ providerId: "groq", modelId: "llama-3.3-70b" }] })
    expect(resolveCheapTier({ modelMappings: [dead], providerSettings })).toBeUndefined()
  })

  it("derives a concrete pair from cost-ordered candidates when there is no alias", () => {
    expect(
      resolveCheapTier({
        providerSettings,
        candidates: [
          { providerId: "groq", modelId: "not-servable" },
          { providerId: "openai", modelId: "gpt-4o-mini" },
        ],
      })
    ).toEqual({ kind: "model", providerId: "openai", modelId: "gpt-4o-mini" })
  })

  it("stays on the current provider among servable candidates", () => {
    // A downshift that also switches vendors throws away prompt-cache
    // locality, which can cost more than the tier change saves.
    expect(
      resolveCheapTier({
        providerSettings,
        preferProviderId: "anthropic",
        candidates: [
          { providerId: "openai", modelId: "gpt-4o-mini" },
          { providerId: "anthropic", modelId: "claude-haiku-4-5-20251001" },
        ],
      })
    ).toMatchObject({ providerId: "anthropic" })
  })

  it("returns undefined rather than inventing a model id", () => {
    // `undefined` is a real answer: the caller sets preferCheap and no hint,
    // which is exactly today's behaviour. Never dead-end a run.
    expect(resolveCheapTier({ providerSettings })).toBeUndefined()
    expect(
      resolveCheapTier({ providerSettings, candidates: [{ providerId: "x", modelId: "y" }] })
    ).toBeUndefined()
  })
})

describe("cheapTierModelHint", () => {
  it("flattens both shapes into the single modelHint slot", () => {
    expect(cheapTierModelHint({ kind: "alias", alias: "fast" })).toBe("fast")
    expect(
      cheapTierModelHint({ kind: "model", providerId: "openai", modelId: "gpt-4o-mini" })
    ).toBe("gpt-4o-mini")
    expect(cheapTierModelHint(undefined)).toBeUndefined()
  })
})
