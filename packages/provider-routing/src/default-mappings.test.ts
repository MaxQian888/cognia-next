import {
  generateDefaultMappings,
  getDefaultTierAliases,
  getTierDisplayName,
} from "./default-mappings"
import type { CatalogRepository } from "@cognia/provider-core/providers/catalog-repository"

const repository: CatalogRepository = {
  listProviders: () => [],
  getModel: () => undefined,
  listOfferings: () => [],
  resolveAlias: () => undefined,
  resolveOffering: () => undefined,
  stageRevision: async () => {},
  activateRevision: async () => {},
  registerContribution: () => () => {},
  searchModels: (query = {}) => {
    const reasoning = query.capabilities?.includes("reasoning")
    const model = {
      id: reasoning ? "creator:reason" : "creator:fast",
      name: reasoning ? "Reason" : "Fast",
      creator: "creator",
      modalities: { input: ["text" as const], output: ["text" as const] },
      capabilities: reasoning
        ? { streaming: true, tools: true, reasoning: true }
        : { streaming: true, tools: true },
      lifecycle: "active" as const,
      provenance: {},
    }
    return [
      {
        model,
        offerings: ["groq", "openai", "anthropic"].map((providerRef) => ({
          id: `${providerRef}:${model.id}`,
          providerRef,
          deploymentRef: providerRef,
          modelRef: model.id,
          upstreamId: `${model.name.toLocaleLowerCase()}-v1`,
          endpointType: "chat-completions" as const,
          lifecycle: "active" as const,
          available: true,
          source: { kind: "bundled" as const, id: "test" },
        })),
      },
    ]
  },
}

describe("generateDefaultMappings", () => {
  it("returns no mappings when no providers are enabled", () => {
    expect(generateDefaultMappings([], repository)).toEqual([])
    expect(generateDefaultMappings(new Set<string>(), repository)).toEqual([])
  })

  it("returns one mapping per tier that has at least one enabled provider", () => {
    const result = generateDefaultMappings(["groq"], repository)
    expect(result.map((m) => m.alias)).toEqual([
      "fast",
      "balanced",
      "powerful",
      "reasoning",
      "coding",
    ])
    const fast = result[0]
    expect(fast.providers).toHaveLength(1)
    expect(fast.providers[0].providerId).toBe("groq")
  })

  it("filters entries within each tier to only enabled providers", () => {
    const result = generateDefaultMappings(["openai", "anthropic"], repository)
    const fast = result.find((m) => m.alias === "fast")
    expect(fast).toBeDefined()
    expect(
      fast!.providers.map((p) => p.providerId).every((p) => ["openai", "anthropic"].includes(p))
    ).toBe(true)
  })

  it("seeds well-formed ModelMapping rows", () => {
    const result = generateDefaultMappings(["openai"], repository)
    expect(result.length).toBeGreaterThan(0)
    for (const m of result) {
      expect(typeof m.id).toBe("string")
      expect(m.id.length).toBeGreaterThan(0)
      expect(typeof m.alias).toBe("string")
      expect(m.distribution).toBe("priority")
      expect(m.enabled).toBe(true)
      expect(m.isDefault).toBe(true)
      expect(typeof m.createdAt).toBe("number")
      expect(typeof m.updatedAt).toBe("number")
      expect(m.providers.length).toBeGreaterThan(0)
      for (const p of m.providers) {
        expect(typeof p.providerId).toBe("string")
        expect(typeof p.modelId).toBe("string")
      }
    }
  })

  it("accepts both array and Set inputs", () => {
    const arr = generateDefaultMappings(["openai", "groq"], repository)
    const set = generateDefaultMappings(new Set(["openai", "groq"]), repository)
    expect(arr.map((m) => m.alias).sort()).toEqual(set.map((m) => m.alias).sort())
  })

  it("omits tiers where no enabled provider matches", () => {
    // 'cohere' isn't listed in any default tier — result must be empty.
    expect(generateDefaultMappings(["cohere"], repository)).toEqual([])
  })

  it("issues unique ids across mappings", () => {
    const result = generateDefaultMappings(
      ["openai", "anthropic", "google", "deepseek"],
      repository
    )
    const ids = result.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("getTierDisplayName", () => {
  it("returns the canonical display name for known tiers", () => {
    expect(getTierDisplayName("fast")).toBe("Fast")
    expect(getTierDisplayName("balanced")).toBe("Balanced")
    expect(getTierDisplayName("powerful")).toBe("Powerful")
    expect(getTierDisplayName("reasoning")).toBe("Reasoning")
  })

  it("falls back to the alias itself for unknown tiers", () => {
    expect(getTierDisplayName("custom")).toBe("custom")
  })
})

describe("getDefaultTierAliases", () => {
  it("returns the list of tier aliases supported by the seed catalog", () => {
    expect(getDefaultTierAliases()).toEqual(["fast", "balanced", "powerful", "reasoning", "coding"])
  })
})
