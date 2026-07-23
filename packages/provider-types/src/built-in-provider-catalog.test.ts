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

  it("registers Amazon Bedrock as a native, region-aware provider", () => {
    expect(getBuiltInProviderCatalogEntry("bedrock")).toMatchObject({
      protocol: "bedrock",
      family: "bedrock-native",
      adapter: "bedrock",
      apiKeyRequired: false,
      baseURLRequired: false,
    })
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

  it("registers cc-switch Anthropic-wire relay presets under the anthropic-native family", () => {
    const relay = getBuiltInProviderCatalogEntry("deepseek-anthropic")
    expect(relay).toMatchObject({
      protocol: "anthropic",
      family: "anthropic-native",
      adapter: "anthropic",
      defaultEnabled: false,
    })
    expect(getBuiltInProviderDefaultBaseURL("glm-anthropic")).toContain("bigmodel.cn")
    expect(getBuiltInProviderDefaultBaseURL("glm-anthropic-intl")).toContain("z.ai")
    // Distinct from the existing OpenAI-compatible DeepSeek entry.
    expect(getBuiltInProviderProtocol("deepseek")).toBe("openai")
    expect(getBuiltInProviderProtocol("deepseek-anthropic")).toBe("anthropic")
  })

  it("gives every anthropic-native relay a non-empty model list containing its default", () => {
    const catalog = getBuiltInProviderCatalog()
    const relays = catalog.filter((e) => e.family === "anthropic-native" && e.defaultBaseURL)
    expect(relays.length).toBeGreaterThanOrEqual(20)
    for (const e of relays) {
      const ids = (e.models ?? []).map((m) => m.id)
      // No relay ships an empty dropdown, and the default is selectable.
      expect(ids.length).toBeGreaterThan(0)
      expect(ids).toContain(e.defaultModel)
    }
    // Kimi specifically (the reported case) carries a current kimi-k2 model.
    expect(getBuiltInProviderDefaultModel("kimi-anthropic")).toBe("kimi-k2.7-code")
    expect(
      (getBuiltInProviderCatalogEntry("kimi-anthropic")?.models ?? []).map((m) => m.id)
    ).toContain("kimi-k2.7-code")
  })

  it("stamps relayOf on every vendor relay so Phase 1 can derive deployments (ADR-0090)", () => {
    const catalog = getBuiltInProviderCatalog()

    // Every `*-anthropic`-suffixed relay names its vendor.
    for (const entry of catalog.filter((e) => e.id.endsWith("-anthropic"))) {
      expect(entry.relayOf).toBeTruthy()
      expect(entry.relayOf).not.toBe(entry.id)
    }
    // Suffix-less coding relays too.
    expect(getBuiltInProviderCatalogEntry("kimi-coding")?.relayOf).toBe("moonshot")
    expect(getBuiltInProviderCatalogEntry("kimi-anthropic")?.relayOf).toBe("moonshot")
    expect(getBuiltInProviderCatalogEntry("glm-anthropic")?.relayOf).toBe("zhipu")
    expect(getBuiltInProviderCatalogEntry("glm-anthropic-intl")?.relayOf).toBe("zhipu")
    expect(getBuiltInProviderCatalogEntry("volcengine-agentplan")?.relayOf).toBe("volcengine")
    // A relayOf naming an in-catalog vendor must resolve; slugs without a
    // catalog entry (qianfan, longcat, …) are synthesized at migration time.
    for (const entry of catalog) {
      if (!entry.relayOf) continue
      const vendor = getBuiltInProviderCatalogEntry(entry.relayOf)
      if (vendor) expect(vendor.id).toBe(entry.relayOf)
    }
    // The Anthropic first-party entry and standalone anthropic-wire
    // aggregators are vendors, not relays.
    expect(getBuiltInProviderCatalogEntry("anthropic")?.relayOf).toBeUndefined()
    expect(getBuiltInProviderCatalogEntry("packycode")?.relayOf).toBeUndefined()
    expect(getBuiltInProviderCatalogEntry("shengsuanyun")?.relayOf).toBeUndefined()
  })

  it("creates quick-add presets only for entries with default base URLs", () => {
    const presets = buildQuickAddProviderPresets()

    expect(presets.length).toBeGreaterThan(0)
    expect(presets.every((preset) => preset.baseURL.length > 0)).toBe(true)
    expect(presets.some((preset) => preset.id === "modelscope")).toBe(true)
  })
})
