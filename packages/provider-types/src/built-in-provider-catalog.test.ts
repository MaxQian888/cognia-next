import {
  BUILT_IN_PROVIDER_IDS,
  buildDefaultBuiltInProviderSettings,
  buildQuickAddProviderPresets,
  getBuiltInProviderCatalog,
  getBuiltInProviderCatalogEntry,
  getBuiltInProviderDefaultBaseURL,
  getBuiltInProviderDefaultModel,
  getBuiltInProviderProtocol,
  getBuiltInProviderSettingsBaseURL,
  isBuiltInProviderId,
} from "./built-in-provider-catalog"

describe("built-in provider catalog", () => {
  it("keeps ids, entries, and lookup helpers aligned", () => {
    const catalog = getBuiltInProviderCatalog()

    expect(catalog).toHaveLength(BUILT_IN_PROVIDER_IDS.length)
    expect(isBuiltInProviderId("openai")).toBe(true)
    expect(isBuiltInProviderId("custom")).toBe(false)
    expect(getBuiltInProviderCatalogEntry("openai")).toMatchObject({
      id: "openai",
      protocol: "openai",
      defaultModel: getBuiltInProviderDefaultModel("openai"),
    })
    expect(getBuiltInProviderProtocol("google")).toBe("gemini")
  })

  it("builds default settings from catalog credential and base URL requirements", () => {
    const settings = buildDefaultBuiltInProviderSettings()

    expect(settings.openai).toMatchObject({ providerId: "openai", apiKey: "", enabled: true })
    expect(settings.ollama).toMatchObject({
      providerId: "ollama",
      apiKey: undefined,
      baseURL: getBuiltInProviderSettingsBaseURL("ollama"),
    })
    expect(getBuiltInProviderDefaultBaseURL("deepseek")).toContain("deepseek")
  })

  it("creates quick-add presets only for entries with default base URLs", () => {
    const presets = buildQuickAddProviderPresets()

    expect(presets.length).toBeGreaterThan(0)
    expect(presets.every((preset) => preset.baseURL.length > 0)).toBe(true)
    expect(presets.some((preset) => preset.id === "modelscope")).toBe(true)
  })
})
