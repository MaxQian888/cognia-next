import {
  DEFAULT_SUBSCRIPTION_PANEL,
  SUBSCRIPTION_NAV_GROUPS,
  resolveSubscriptionPanel,
} from "./nav-config"

describe("SUBSCRIPTION_NAV_GROUPS", () => {
  it("has no duplicate panel ids across groups", () => {
    const ids = SUBSCRIPTION_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("covers every group exactly once", () => {
    expect(SUBSCRIPTION_NAV_GROUPS.map((g) => g.id)).toEqual([
      "usageGroup",
      "providersGroup",
      "vaultGroup",
    ])
  })
})

describe("resolveSubscriptionPanel", () => {
  it("defaults with no params", () => {
    expect(resolveSubscriptionPanel(null, null)).toBe(DEFAULT_SUBSCRIPTION_PANEL)
  })

  it("passes a valid panel id through", () => {
    expect(resolveSubscriptionPanel("codex", null)).toBe("codex")
    expect(resolveSubscriptionPanel("backup", null)).toBe("backup")
    expect(resolveSubscriptionPanel("sync", null)).toBe("sync")
  })

  it("defaults on an unknown panel id", () => {
    expect(resolveSubscriptionPanel("ALIEN", null)).toBe(DEFAULT_SUBSCRIPTION_PANEL)
  })

  // Pre-merge deep links used the nested `?subTab=anthropic&innerTab=X` form.
  describe("legacy links", () => {
    it.each([
      ["overview", "overview"],
      ["usage", "usage"],
      ["account", "claude"],
      ["settings", "probes"],
    ])("maps innerTab=%s to %s", (inner, expected) => {
      expect(resolveSubscriptionPanel("anthropic", inner)).toBe(expected)
      // `innerTab` was Anthropic-only, so a bare one means the same thing.
      expect(resolveSubscriptionPanel(null, inner)).toBe(expected)
    })

    it("lands a bare subTab=anthropic on the default, as it always did", () => {
      expect(resolveSubscriptionPanel("anthropic", null)).toBe(DEFAULT_SUBSCRIPTION_PANEL)
    })

    it("defaults on an unknown innerTab", () => {
      expect(resolveSubscriptionPanel("anthropic", "ALIEN")).toBe(DEFAULT_SUBSCRIPTION_PANEL)
    })

    // `innerTab` never applied to codex/opencode, so it must not hijack them.
    it("ignores innerTab under a non-anthropic provider", () => {
      expect(resolveSubscriptionPanel("codex", "usage")).toBe("codex")
      expect(resolveSubscriptionPanel("opencode", "account")).toBe("opencode")
    })
  })
})
