import {
  BUILT_IN_PRESETS,
  getBuiltInPreset,
  makeTelemetrySnapshot,
  pickTopEntry,
  resolveModelAlias,
} from "./index"
import type {
  ModelMapping,
  ModelMappingEntry,
  ModelMappingRegistry,
} from "@cognia/provider-types/model-mapping"

function entry(providerId: string, modelId: string): ModelMappingEntry {
  return { providerId, modelId }
}

function mapping(alias: string, providers: ModelMappingEntry[]): ModelMapping {
  return {
    id: alias,
    alias,
    providers,
    distribution: "priority",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("provider-routing package barrel", () => {
  it("re-exports alias resolution helpers", () => {
    const registry: ModelMappingRegistry = {
      enabled: true,
      mappings: [mapping("fast", [entry("groq", "llama")])],
    }

    const resolved = resolveModelAlias("fast", registry)
    expect(pickTopEntry(resolved)).toEqual(entry("groq", "llama"))
  })

  it("re-exports presets and strategy telemetry helpers", () => {
    expect(BUILT_IN_PRESETS.map((preset) => preset.builtInId)).toEqual([
      "budget",
      "performance",
      "reliability",
    ])
    expect(getBuiltInPreset("budget")?.strategy).toBe("cost")
    const snapshot = makeTelemetrySnapshot({
      getHealthMetrics: () => undefined,
      getPricing: () => undefined,
    })
    expect(snapshot.getInFlight("openai")).toBe(0)
  })
})
