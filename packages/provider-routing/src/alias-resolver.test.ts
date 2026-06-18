import { resolveModelAlias, pickTopEntry, type ProviderHealthMetricsLite } from "./alias-resolver"
import type {
  ModelMapping,
  ModelMappingEntry,
  ModelMappingRegistry,
} from "@/types/provider/model-mapping"

function entry(
  providerId: string,
  modelId: string,
  extras: Partial<ModelMappingEntry> = {}
): ModelMappingEntry {
  return { providerId, modelId, ...extras }
}

function mapping(
  alias: string,
  providers: ModelMappingEntry[],
  extras: Partial<ModelMapping> = {}
): ModelMapping {
  return {
    id: `m-${alias}`,
    alias,
    providers,
    distribution: "priority",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...extras,
  }
}

function registry(mappings: ModelMapping[], enabled = true): ModelMappingRegistry {
  return { mappings, enabled }
}

describe("resolveModelAlias", () => {
  it("returns not-found when the registry is globally disabled", () => {
    const reg = registry([mapping("fast", [entry("groq", "llama")])], false)
    const result = resolveModelAlias("fast", reg)
    expect(result.found).toBe(false)
    expect(result.entries).toEqual([])
  })

  it("returns not-found when the alias does not match any mapping", () => {
    const reg = registry([mapping("fast", [entry("groq", "llama")])])
    const result = resolveModelAlias("missing", reg)
    expect(result.found).toBe(false)
    expect(result.entries).toEqual([])
  })

  it("ignores disabled mappings", () => {
    const reg = registry([mapping("fast", [entry("groq", "llama")], { enabled: false })])
    expect(resolveModelAlias("fast", reg).found).toBe(false)
  })

  it("matches aliases case-insensitively", () => {
    const reg = registry([mapping("Fast", [entry("groq", "llama")])])
    const result = resolveModelAlias("FAST", reg)
    expect(result.found).toBe(true)
    expect(result.entries).toEqual([entry("groq", "llama")])
  })

  it("returns priority-ordered entries unchanged for priority distribution", () => {
    const entries = [entry("openai", "gpt-4o"), entry("anthropic", "claude-sonnet-4-20250514")]
    const reg = registry([mapping("balanced", entries)])
    const result = resolveModelAlias("balanced", reg)
    expect(result.found).toBe(true)
    expect(result.entries).toEqual(entries)
    // The result should be a fresh array (resolver clones it)
    expect(result.entries).not.toBe(entries)
  })

  it("includes the parameterDefaults from the mapping", () => {
    const reg = registry([
      mapping("coding", [entry("anthropic", "claude")], {
        parameterDefaults: { temperature: 0.1 },
      }),
    ])
    const result = resolveModelAlias("coding", reg)
    expect(result.parameterDefaults).toEqual({ temperature: 0.1 })
  })

  describe("condition filtering", () => {
    const conditioned: ModelMapping = mapping("fast", [
      entry("openai", "gpt-4o", { conditions: { maxCostPer1M: 1.0 } }),
      entry("groq", "llama", { conditions: { maxLatencyMs: 200 } }),
      entry("anthropic", "claude", {
        conditions: { maxCostPer1M: 5, maxLatencyMs: 1000 },
      }),
      // Entry without conditions always survives
      entry("deepseek", "v4-flash"),
    ])
    const reg = registry([conditioned])

    it("drops entries whose cost exceeds maxCostPer1M", () => {
      const metrics: Record<string, ProviderHealthMetricsLite> = {
        "openai:gpt-4o": { costPer1M: 2.5 },
      }
      const result = resolveModelAlias("fast", reg, metrics)
      expect(result.entries.find((e) => e.providerId === "openai")).toBeUndefined()
      expect(result.entries.find((e) => e.providerId === "deepseek")).toBeDefined()
    })

    it("drops entries whose latency exceeds maxLatencyMs", () => {
      const metrics: Record<string, ProviderHealthMetricsLite> = {
        "groq:llama": { latencyMs: 800 },
      }
      const result = resolveModelAlias("fast", reg, metrics)
      expect(result.entries.find((e) => e.providerId === "groq")).toBeUndefined()
    })

    it("keeps entries within both cost and latency limits", () => {
      const metrics: Record<string, ProviderHealthMetricsLite> = {
        "anthropic:claude": { costPer1M: 4, latencyMs: 500 },
      }
      const result = resolveModelAlias("fast", reg, metrics)
      expect(result.entries.find((e) => e.providerId === "anthropic")).toBeDefined()
    })

    it("keeps entries when no metrics are provided for them", () => {
      const result = resolveModelAlias("fast", reg, {})
      // No metrics for any of them = nothing filtered out
      expect(result.entries).toHaveLength(4)
    })

    it("ignores conditions when the entry has none", () => {
      const metrics: Record<string, ProviderHealthMetricsLite> = {
        "deepseek:v4-flash": { costPer1M: 999, latencyMs: 9999 },
      }
      const result = resolveModelAlias("fast", reg, metrics)
      // deepseek has no conditions block, so it should survive any metrics
      expect(result.entries.find((e) => e.providerId === "deepseek")).toBeDefined()
    })
  })

  describe("weighted distribution", () => {
    it("returns a clone for a single-entry weighted mapping", () => {
      const single = [entry("openai", "gpt-4o", { weight: 5 })]
      const reg = registry([mapping("solo", single, { distribution: "weighted" })])
      const result = resolveModelAlias("solo", reg)
      expect(result.entries).toEqual(single)
      expect(result.entries).not.toBe(single)
    })

    it("distributes weighted entries across all candidates over many runs", () => {
      const entries = [
        entry("openai", "a", { weight: 1 }),
        entry("anthropic", "b", { weight: 100 }),
      ]
      const reg = registry([mapping("w", entries, { distribution: "weighted" })])

      const firstPicks = new Map<string, number>()
      for (let i = 0; i < 200; i++) {
        const result = resolveModelAlias("w", reg)
        const top = result.entries[0]
        firstPicks.set(top.providerId, (firstPicks.get(top.providerId) ?? 0) + 1)
      }

      // The high-weight entry should dominate the first slot.
      expect(firstPicks.get("anthropic") ?? 0).toBeGreaterThan(firstPicks.get("openai") ?? 0)
      // Both entries should still be reachable (tail of the shuffle).
      const all = new Set<string>()
      for (let i = 0; i < 50; i++) {
        for (const e of resolveModelAlias("w", reg).entries) {
          all.add(e.providerId)
        }
      }
      expect(all.size).toBe(2)
    })

    it("falls back to declaration order when every weight is zero", () => {
      const entries = [entry("first", "a", { weight: 0 }), entry("second", "b", { weight: 0 })]
      const reg = registry([mapping("z", entries, { distribution: "weighted" })])
      const result = resolveModelAlias("z", reg)
      expect(result.entries.map((e) => e.providerId)).toEqual(["first", "second"])
    })

    it("treats missing weights as 1", () => {
      const entries = [entry("a", "1"), entry("b", "2")]
      const reg = registry([mapping("e", entries, { distribution: "weighted" })])
      // No exception — and both entries appear in the result.
      const result = resolveModelAlias("e", reg)
      expect(result.entries).toHaveLength(2)
    })
  })
})

describe("pickTopEntry", () => {
  it("returns the first entry when present", () => {
    const result = {
      found: true,
      entries: [entry("openai", "gpt-4o"), entry("anthropic", "claude")],
    }
    expect(pickTopEntry(result)).toEqual(entry("openai", "gpt-4o"))
  })

  it("returns null when the entries list is empty", () => {
    expect(pickTopEntry({ found: false, entries: [] })).toBeNull()
  })
})
