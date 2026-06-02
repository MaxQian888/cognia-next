import { buildPresetTemplates, findPresetTemplate } from "./preset-templates"

describe("buildPresetTemplates", () => {
  it("always offers a blank Custom template first", () => {
    for (const provider of ["anthropic", "codex"] as const) {
      const templates = buildPresetTemplates(provider)
      expect(templates[0]).toMatchObject({ templateId: "custom", baseUrl: "", provider })
    }
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
