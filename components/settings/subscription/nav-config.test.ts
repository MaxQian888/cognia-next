import {
  buildSubscriptionNavGroups,
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
    expect(resolveSubscriptionPanel("commandcode", null)).toBe("commandcode")
    expect(resolveSubscriptionPanel("accounts", null)).toBe("accounts")
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
      ["account", "accounts"],
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

it("builds dynamic provider navigation and excludes unavailable plugin definitions", () => {
  const groups = buildSubscriptionNavGroups([
    {
      id: "my-provider",
      name: "My Provider",
      baseUrl: "https://provider.example/v1",
      authMode: "api-key",
      source: "custom",
    },
    {
      id: "removed-provider",
      name: "Removed",
      authMode: "api-key",
      source: "unavailable",
      available: false,
    },
  ])
  const items = groups.flatMap((group) => group.items)
  expect(items).toContainEqual(expect.objectContaining({ id: "my-provider", label: "My Provider" }))
  expect(items.some((item) => item.id === "removed-provider")).toBe(false)
  expect(resolveSubscriptionPanel("my-provider", null, new Set(items.map((item) => item.id)))).toBe(
    "my-provider"
  )
})
