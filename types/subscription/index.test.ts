import {
  type AccountSummary,
  type ProviderCredential,
  providerIdForCredential,
  variantOf,
  ALL_PROVIDER_IDS,
  isValidSubscriptionProviderId,
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
    expect(
      providerIdForCredential({ provider: "commandcode", accessToken: "key", storedAtMs: 0 })
    ).toBe("commandcode")
  })
})

describe("variantOf", () => {
  it.each([
    ["anthropic", "anthropic"],
    ["codex", "codex"],
    ["opencode-discovered", "opencode-discovered"],
    ["opencode-zen", "opencode-zen"],
    ["commandcode", "commandcode"],
  ] as const)("returns %s for variant tag %s", (input, expected) => {
    const credential = { provider: input } as unknown as ProviderCredential
    expect(variantOf(credential)).toBe(expected as AccountSummary["variant"])
  })
})

describe("ALL_PROVIDER_IDS", () => {
  it("enumerates the four providers in canonical order", () => {
    expect(ALL_PROVIDER_IDS).toEqual(["anthropic", "codex", "opencode", "commandcode"])
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

  it("codex defaults auto-refresh, and carry no live-discovery opt-in", () => {
    expect(DEFAULT_CODEX_SUBSCRIPTION_SETTINGS.autoRefreshNearExpiry).toBe(true)
    // Env injection requires an explicitly adopted account (ADR-0025); there is
    // no flag that re-enables reading ~/.codex/auth.json at spawn.
    expect(DEFAULT_CODEX_SUBSCRIPTION_SETTINGS).not.toHaveProperty("preferDiscovered")
  })
})

describe("registry provider credentials", () => {
  it("keeps provider identity separate from generic credential kind", () => {
    const credential: ProviderCredential = {
      provider: "api-key",
      providerId: "custom:example",
      accessToken: "test",
      storedAtMs: 0,
    }
    expect(providerIdForCredential(credential)).toBe("custom:example")
    expect(variantOf(credential)).toBe("api-key")
  })
  it("accepts canonical namespaced ids and rejects unsafe boundaries", () => {
    expect(isValidSubscriptionProviderId("plugin:example.provider")).toBe(true)
    for (const id of ["", "Bad", "a/b", "../secret", "a\nsecret", "x".repeat(129), "  demo"]) {
      expect(isValidSubscriptionProviderId(id)).toBe(false)
    }
  })
})
