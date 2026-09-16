import type { AppSettings } from "@cognia/agent-config-types"
import type { ModelMapping } from "@cognia/provider-types/model-mapping"
import { isRoutingPlaceholderModel, resolveRoleTierModel } from "./auto-model-resolution"

function mapping(
  alias: string,
  providers: Array<{ providerId: string; modelId: string }>,
  enabled = true
): ModelMapping {
  return {
    id: `m-${alias}`,
    alias,
    providers,
    distribution: "priority",
    enabled,
    createdAt: 1,
    updatedAt: 1,
  }
}

function settings(modelMappings: ModelMapping[], candidateAliases?: string[]): AppSettings {
  return {
    modelMappings,
    ...(candidateAliases ? { autoRouting: { enabled: false, candidateAliases } } : {}),
  } as unknown as AppSettings
}

describe("isRoutingPlaceholderModel", () => {
  it("flags the literal 'auto' case-insensitively", () => {
    expect(isRoutingPlaceholderModel("auto", undefined)).toBe(true)
    expect(isRoutingPlaceholderModel("AUTO", [])).toBe(true)
    expect(isRoutingPlaceholderModel("Auto", undefined)).toBe(true)
  })

  it("flags an enabled alias name and ignores a disabled one", () => {
    const mappings = [
      mapping("fast", [{ providerId: "groq", modelId: "llama" }]),
      mapping("cheap", [{ providerId: "groq", modelId: "m" }], false),
    ]
    expect(isRoutingPlaceholderModel("fast", mappings)).toBe(true)
    expect(isRoutingPlaceholderModel("FAST", mappings)).toBe(true)
    expect(isRoutingPlaceholderModel("cheap", mappings)).toBe(false)
  })

  it("leaves concrete model ids and undefined alone", () => {
    const mappings = [mapping("fast", [{ providerId: "groq", modelId: "llama" }])]
    expect(isRoutingPlaceholderModel("gpt-4o", mappings)).toBe(false)
    expect(isRoutingPlaceholderModel("claude-haiku-4-5", undefined)).toBe(false)
    expect(isRoutingPlaceholderModel(undefined, mappings)).toBe(false)
  })
})

describe("resolveRoleTierModel", () => {
  const three = [
    mapping("fast", [{ providerId: "groq", modelId: "llama" }]),
    mapping("balanced", [{ providerId: "openai", modelId: "gpt-4o-mini" }]),
    mapping("powerful", [{ providerId: "anthropic", modelId: "claude-opus" }]),
  ]

  it("maps plan to the last rung, execute to the middle, utility to the first", () => {
    expect(resolveRoleTierModel({ role: "plan", appSettings: settings(three) })).toEqual({
      providerId: "anthropic",
      modelId: "claude-opus",
    })
    expect(resolveRoleTierModel({ role: "execute", appSettings: settings(three) })).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    })
    expect(resolveRoleTierModel({ role: "utility", appSettings: settings(three) })).toEqual({
      providerId: "groq",
      modelId: "llama",
    })
  })

  it("walks down first, then up, when the target rung is disabled", () => {
    const noMiddle = [
      mapping("fast", [{ providerId: "groq", modelId: "llama" }]),
      mapping("balanced", [{ providerId: "openai", modelId: "gpt-4o-mini" }], false),
      mapping("powerful", [{ providerId: "anthropic", modelId: "claude-opus" }]),
    ]
    // execute targets index 1; disabled → walks down to "fast" before climbing.
    expect(resolveRoleTierModel({ role: "execute", appSettings: settings(noMiddle) })).toEqual({
      providerId: "groq",
      modelId: "llama",
    })
    const onlyMiddle = [
      mapping("fast", [{ providerId: "groq", modelId: "llama" }], false),
      mapping("balanced", [{ providerId: "openai", modelId: "gpt-4o-mini" }]),
      mapping("powerful", [{ providerId: "anthropic", modelId: "claude-opus" }], false),
    ]
    // plan targets the last rung; disabled rungs below it are walked down
    // first, but with nothing enabled below it climbs — down-first applies
    // only to ENABLED rungs.
    expect(resolveRoleTierModel({ role: "plan", appSettings: settings(onlyMiddle) })).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    })
  })

  it("honours a configured candidateAliases ladder over the default", () => {
    const custom = [
      mapping("lite", [{ providerId: "groq", modelId: "lite-m" }]),
      mapping("pro", [{ providerId: "openai", modelId: "pro-m" }]),
    ]
    expect(
      resolveRoleTierModel({
        role: "plan",
        appSettings: settings(custom, ["lite", "pro"]),
      })
    ).toEqual({ providerId: "openai", modelId: "pro-m" })
  })

  it("does not require autoRouting.enabled — the aliases carry the meaning", () => {
    const appSettings = settings(three, ["fast", "balanced", "powerful"])
    // `settings()` above already writes enabled: false; make it explicit.
    expect(appSettings.autoRouting?.enabled).toBe(false)
    expect(resolveRoleTierModel({ role: "utility", appSettings })).toEqual({
      providerId: "groq",
      modelId: "llama",
    })
  })

  it("returns undefined when nothing is configured or enabled", () => {
    expect(resolveRoleTierModel({ role: "plan", appSettings: undefined })).toBeUndefined()
    expect(resolveRoleTierModel({ role: "plan", appSettings: settings([]) })).toBeUndefined()
    expect(
      resolveRoleTierModel({
        role: "utility",
        appSettings: settings([mapping("fast", [{ providerId: "groq", modelId: "llama" }], false)]),
      })
    ).toBeUndefined()
  })
})
