import {
  AI_PANEL_IDS,
  DEFAULT_AI_PANEL,
  DEFAULT_PROVIDER_TAB,
  PROVIDER_TAB_IDS,
  isProviderIdShaped,
  resolveAiPanel,
  resolveProviderTab,
} from "./nav-config"

describe("resolveAiPanel", () => {
  it("keeps every declared panel", () => {
    for (const id of AI_PANEL_IDS) {
      expect(resolveAiPanel(id)).toBe(id)
    }
  })

  it("falls back for a missing or unknown value", () => {
    expect(resolveAiPanel(null)).toBe(DEFAULT_AI_PANEL)
    expect(resolveAiPanel(undefined)).toBe(DEFAULT_AI_PANEL)
    expect(resolveAiPanel("")).toBe(DEFAULT_AI_PANEL)
    expect(resolveAiPanel("routing-workspace")).toBe(DEFAULT_AI_PANEL)
  })
})

describe("resolveProviderTab", () => {
  it("keeps every declared tab", () => {
    for (const id of PROVIDER_TAB_IDS) {
      expect(resolveProviderTab(id)).toBe(id)
    }
  })

  it("falls back for a missing or unknown value", () => {
    expect(resolveProviderTab(null)).toBe(DEFAULT_PROVIDER_TAB)
    expect(resolveProviderTab("advanced")).toBe(DEFAULT_PROVIDER_TAB)
  })

  it("does not honour the retired tab names", () => {
    // `config` and `cost` were renamed, `advanced` was deleted. A stale
    // bookmark should land on Connect, not on nothing.
    expect(resolveProviderTab("config")).toBe("connect")
    expect(resolveProviderTab("cost")).toBe("connect")
  })

  it("puts connect first so the default matches the strip order", () => {
    expect(PROVIDER_TAB_IDS[0]).toBe(DEFAULT_PROVIDER_TAB)
  })
})

describe("isProviderIdShaped", () => {
  it("accepts the id shapes the catalog and custom providers actually use", () => {
    expect(isProviderIdShaped("openai")).toBe(true)
    expect(isProviderIdShaped("azure-openai")).toBe(true)
    expect(isProviderIdShaped("custom_1730000000000")).toBe(true)
    expect(isProviderIdShaped("vertex:gemini")).toBe(true)
    expect(isProviderIdShaped("models.dev")).toBe(true)
  })

  it("rejects values that could never be an id", () => {
    expect(isProviderIdShaped(null)).toBe(false)
    expect(isProviderIdShaped(undefined)).toBe(false)
    expect(isProviderIdShaped("")).toBe(false)
    expect(isProviderIdShaped("a b")).toBe(false)
    expect(isProviderIdShaped("../../etc/passwd")).toBe(false)
    expect(isProviderIdShaped('"><img src=x>')).toBe(false)
    expect(isProviderIdShaped("x".repeat(129))).toBe(false)
  })

  it("accepts an id the catalog does not carry", () => {
    // Deliberately not a catalog lookup: a deleted custom provider still has
    // to reach the detail pane so it can say the selection is stale.
    expect(isProviderIdShaped("a-provider-that-was-deleted")).toBe(true)
  })
})
