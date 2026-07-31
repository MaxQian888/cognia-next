import {
  BUDGET_PRESET,
  BUILT_IN_PRESETS,
  adaptPresetToEnabledProviders,
  getBuiltInPreset,
} from "./built-in-presets"
import type { CatalogRepository } from "@cognia/provider-core"

const repository = {
  searchModels: () => [
    {
      model: {
        id: "creator:model",
        name: "Model",
        creator: "creator",
        modalities: { input: ["text"], output: ["text"] },
        capabilities: { streaming: true, tools: true, reasoning: true },
        lifecycle: "active",
        provenance: {},
      },
      offerings: ["groq", "deepseek"].map((providerRef) => ({
        id: `${providerRef}:model`,
        providerRef,
        deploymentRef: providerRef,
        modelRef: "creator:model",
        upstreamId: "model",
        endpointType: "chat-completions",
        lifecycle: "active",
        available: true,
        source: { kind: "bundled", id: "test" },
      })),
    },
  ],
} as CatalogRepository

describe("provider-routing built-in presets", () => {
  it("exposes budget, performance, and reliability presets", () => {
    expect(BUILT_IN_PRESETS).toHaveLength(3)
    expect(getBuiltInPreset("budget")).toBe(BUDGET_PRESET)
    expect(getBuiltInPreset("reliability")?.routingConfig?.maxFallbackAttempts).toBe(5)
  })

  it("drops mappings that have no enabled providers after adaptation", () => {
    const adapted = adaptPresetToEnabledProviders(BUDGET_PRESET, new Set(["groq"]), repository)

    expect(adapted.mappings.length).toBeLessThanOrEqual(BUDGET_PRESET.mappings.length)
    expect(adapted.mappings.every((mapping) => mapping.providers.length > 0)).toBe(true)
    expect(
      adapted.mappings
        .flatMap((mapping) => mapping.providers)
        .every((entry) => entry.providerId === "groq")
    ).toBe(true)
  })
})
