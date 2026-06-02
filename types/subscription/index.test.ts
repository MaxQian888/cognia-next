import {
  type AccountSummary,
  type ProviderCredential,
  providerIdForCredential,
  variantOf,
  ALL_PROVIDER_IDS,
  DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS,
  DEFAULT_CODEX_SUBSCRIPTION_SETTINGS,
} from "."

describe("providerIdForCredential", () => {
  it("dispatches each variant to its parent provider", () => {
    const anthropic: ProviderCredential = {
      provider: "anthropic",
      accessToken: "a",
      refreshToken: "r",
      expiresAtMs: 0,
      mode: "subscription",
      storedAtMs: 0,
    }
    const codex: ProviderCredential = {
      provider: "codex",
      accessToken: "a",
      refreshToken: "",
      idTokenRaw: "",
      expiresAtMs: 0,
      authMode: "chatgpt",
      storedAtMs: 0,
    }
    const discovered: ProviderCredential = {
      provider: "opencode-discovered",
      subProvider: "anthropic",
      authJsonPath: "/a/b",
      originalPayloadJson: "{}",
      lastSeenAtMs: 0,
    }
    const zen: ProviderCredential = {
      provider: "opencode-zen",
      accessToken: "ozk",
      storedAtMs: 0,
    }
    expect(providerIdForCredential(anthropic)).toBe("anthropic")
    expect(providerIdForCredential(codex)).toBe("codex")
    expect(providerIdForCredential(discovered)).toBe("opencode")
    expect(providerIdForCredential(zen)).toBe("opencode")
  })
})

describe("variantOf", () => {
  it.each([
    ["anthropic", "anthropic"],
    ["codex", "codex"],
    ["opencode-discovered", "opencode-discovered"],
    ["opencode-zen", "opencode-zen"],
  ] as const)("returns %s for variant tag %s", (input, expected) => {
    const credential = { provider: input } as unknown as ProviderCredential
    expect(variantOf(credential)).toBe(expected as AccountSummary["variant"])
  })
})

describe("ALL_PROVIDER_IDS", () => {
  it("enumerates the three providers in canonical order", () => {
    expect(ALL_PROVIDER_IDS).toEqual(["anthropic", "codex", "opencode"])
  })
})

describe("DEFAULT_*_SUBSCRIPTION_SETTINGS", () => {
  it("anthropic defaults are passive-first", () => {
    expect(DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS.probeEnabled).toBe(false)
    expect(DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS.warnThresholdPct).toBe(90)
    expect(DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS.visibleIntervalMs).toBeGreaterThanOrEqual(
      60 * 1000
    )
  })

  it("codex defaults prefer live discovery + auto-refresh", () => {
    expect(DEFAULT_CODEX_SUBSCRIPTION_SETTINGS.preferDiscovered).toBe(true)
    expect(DEFAULT_CODEX_SUBSCRIPTION_SETTINGS.autoRefreshNearExpiry).toBe(true)
  })
})
