import type { AppSettings } from "@cognia/agent-config-types"
import { computeEnabledProviderIds, seedDefaultMappingsIfNeeded } from "./seed-default-mappings"

function makeSettings(p: Partial<AppSettings> = {}): AppSettings {
  return { id: "singleton", ...p } as AppSettings
}

describe("computeEnabledProviderIds", () => {
  it("always includes anthropic when not explicitly disabled", () => {
    expect(computeEnabledProviderIds(makeSettings()).has("anthropic")).toBe(true)
    expect(computeEnabledProviderIds(null).has("anthropic")).toBe(true)
  })

  it("excludes a provider whose entry is enabled:false and includes the rest", () => {
    const ids = computeEnabledProviderIds(
      makeSettings({
        providerSettings: {
          openai: { enabled: true },
          groq: { enabled: false },
        } as unknown as AppSettings["providerSettings"],
      })
    )
    expect(ids.has("openai")).toBe(true)
    expect(ids.has("groq")).toBe(false)
    expect(ids.has("anthropic")).toBe(true)
  })

  it("excludes anthropic only when explicitly disabled", () => {
    const ids = computeEnabledProviderIds(
      makeSettings({
        providerSettings: {
          anthropic: { enabled: false },
        } as unknown as AppSettings["providerSettings"],
      })
    )
    expect(ids.has("anthropic")).toBe(false)
  })

  it("includes enabled custom providers by id", () => {
    const ids = computeEnabledProviderIds(
      makeSettings({
        customProviders: [
          { id: "my-proxy", enabled: true },
          { id: "off-proxy", enabled: false },
        ] as AppSettings["customProviders"],
      })
    )
    expect(ids.has("my-proxy")).toBe(true)
    expect(ids.has("off-proxy")).toBe(false)
  })
})

describe("seedDefaultMappingsIfNeeded", () => {
  it("seeds tier aliases when modelMappings is empty and a provider is enabled", () => {
    const before = makeSettings() // anthropic is always enabled
    const after = seedDefaultMappingsIfNeeded(before)
    expect(after).not.toBe(before)
    expect((after.modelMappings ?? []).length).toBeGreaterThan(0)
    expect((after.modelMappings ?? []).some((m) => m.alias === "fast")).toBe(true)
    // Seeds are flagged as defaults so the preset machinery can snapshot them.
    expect((after.modelMappings ?? []).every((m) => m.isDefault)).toBe(true)
  })

  it("returns the same reference (no reseed) when mappings already exist", () => {
    const before = makeSettings({
      modelMappings: [
        {
          id: "custom-1",
          alias: "custom",
          providers: [{ providerId: "openai", modelId: "gpt-4o" }],
          distribution: "priority",
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    })
    expect(seedDefaultMappingsIfNeeded(before)).toBe(before)
  })

  it("returns the same reference when no providers are enabled", () => {
    const before = makeSettings({
      providerSettings: {
        anthropic: { enabled: false },
      } as unknown as AppSettings["providerSettings"],
    })
    expect(seedDefaultMappingsIfNeeded(before)).toBe(before)
  })

  it("returns the same reference when enabled providers match no tier", () => {
    // A custom provider that isn't in any tier catalog, with Anthropic
    // disabled, yields enabled ids but zero generated mappings.
    const before = makeSettings({
      providerSettings: {
        anthropic: { enabled: false },
      } as unknown as AppSettings["providerSettings"],
      customProviders: [{ id: "weirdo", enabled: true }] as AppSettings["customProviders"],
    })
    expect(seedDefaultMappingsIfNeeded(before)).toBe(before)
  })
})
