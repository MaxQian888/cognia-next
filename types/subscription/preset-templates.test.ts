import { buildPresetTemplates, findPresetTemplate } from "./preset-templates"

describe("buildPresetTemplates", () => {
  it("always offers a blank Custom template first", () => {
    for (const provider of ["anthropic", "codex"] as const) {
      const templates = buildPresetTemplates(provider)
      expect(templates[0]).toMatchObject({ templateId: "custom", baseUrl: "", provider })
    }
  })

  it("projects anthropic-native relays (cc-switch presets) with concrete base URLs", () => {
    const anthropic = buildPresetTemplates("anthropic")
    const relays = anthropic.filter((t) => t.templateId !== "custom")
    expect(relays.length).toBeGreaterThan(0)
    for (const t of relays) {
      expect(t.baseUrl).toMatch(/^https?:\/\//)
      expect(t.provider).toBe("anthropic")
    }
    // Representative cc-switch relays should surface as one-click templates.
    expect(relays.some((t) => t.templateId === "deepseek-anthropic")).toBe(true)
    expect(relays.some((t) => t.templateId === "glm-anthropic")).toBe(true)
    // The official Anthropic entry has no base URL → never offered as a template.
    expect(relays.some((t) => t.templateId === "anthropic")).toBe(false)
  })

  it("projects codex (openai-compatible / openrouter) relays with concrete base URLs", () => {
    const codex = buildPresetTemplates("codex")
    const relays = codex.filter((t) => t.templateId !== "custom")
    expect(relays.length).toBeGreaterThan(0)
    // Every non-custom template carries a real https endpoint.
    for (const t of relays) {
      expect(t.baseUrl).toMatch(/^https?:\/\//)
      expect(t.provider).toBe("codex")
    }
    // OpenRouter is an openrouter-family relay and should appear.
    expect(relays.some((t) => t.templateId === "openrouter")).toBe(true)
  })

  it("sorts relay templates alphabetically by label", () => {
    const relays = buildPresetTemplates("codex").filter((t) => t.templateId !== "custom")
    const labels = relays.map((t) => t.label)
    const sorted = [...labels].sort((a, b) => a.localeCompare(b))
    expect(labels).toEqual(sorted)
  })

  it("never includes a relay without a base URL", () => {
    for (const provider of ["anthropic", "codex"] as const) {
      for (const t of buildPresetTemplates(provider)) {
        if (t.templateId === "custom") continue
        expect(t.baseUrl.length).toBeGreaterThan(0)
      }
    }
  })
})

describe("findPresetTemplate", () => {
  it("finds a known template by id", () => {
    const t = findPresetTemplate("codex", "openrouter")
    expect(t?.templateId).toBe("openrouter")
    expect(t?.baseUrl).toMatch(/^https?:\/\//)
  })

  it("returns the custom template for the 'custom' id", () => {
    expect(findPresetTemplate("anthropic", "custom")?.baseUrl).toBe("")
  })

  it("returns undefined for an unknown id", () => {
    expect(findPresetTemplate("codex", "does-not-exist")).toBeUndefined()
  })
})

describe("ADR-0090 Phase 1 — legacy alias stability", () => {
  it("every relay template id keeps resolving through the profile-migration legacy aliases", async () => {
    // The Provider Profile Store derivation is identity-preserving for relay
    // ids (deployment id === legacy provider id), so ccswitch/subscription
    // templates like glm-anthropic must survive migration unchanged.
    const { deriveProfiles } = await import("@cognia/provider-types/profile-migration")
    const { getBuiltInProviderCatalog } =
      await import("@cognia/provider-types/built-in-provider-catalog")
    const relays = buildPresetTemplates("anthropic").filter((t) => t.templateId !== "custom")
    const providerSettings = Object.fromEntries(
      relays.map((t) => [t.templateId, { providerId: t.templateId, enabled: true }])
    )
    const derived = deriveProfiles({
      catalog: getBuiltInProviderCatalog(),
      providerSettings,
    })
    for (const t of relays) {
      expect(derived.legacyAliases[t.templateId]).toBe(t.templateId)
    }
  })
})
