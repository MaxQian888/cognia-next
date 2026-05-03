import {
  getBuiltinProviderChatRuntimeMessage,
  getActiveCredential,
  getBuiltInProviderReadiness,
  getChatRuntimeProviderGuard,
  getCustomProviderReadiness,
  getProviderEnableEligibility,
  getVisibleEligibleBuiltInProviderIds,
  getVisibleRetryFailedBuiltInProviderIds,
  getVisibleEligibleCustomProviderIds,
  getVisibleRetryFailedCustomProviderIds,
  getVisibleSelectedProviderIds,
  hasAnyCredential,
} from "./provider-readiness"

describe("provider-readiness helpers", () => {
  it("extracts active credential from primary apiKey first", () => {
    expect(getActiveCredential({ apiKey: "  sk-primary  ", apiKeys: ["sk-fallback"] })).toBe(
      "sk-primary"
    )
  })

  it("extracts active credential from indexed apiKey pool", () => {
    expect(
      getActiveCredential({
        apiKeys: ["sk-one", "sk-two"],
        currentKeyIndex: 1,
      })
    ).toBe("sk-two")
  })

  it("detects credential presence across primary and pool keys", () => {
    expect(hasAnyCredential({ apiKey: "sk-primary" })).toBe(true)
    expect(hasAnyCredential({ apiKeys: [" ", "sk-two"] })).toBe(true)
    expect(hasAnyCredential({ apiKeys: [" ", ""] })).toBe(false)
    expect(hasAnyCredential(undefined)).toBe(false)
  })

  it("marks remote provider unconfigured without credential", () => {
    const state = getBuiltInProviderReadiness("openai", { enabled: false }, null)
    expect(state.readiness).toBe("unconfigured")
    expect(state.eligibility.enable.allowed).toBe(false)
    expect(state.eligibility.testConnection.allowed).toBe(false)
  })

  it("marks remote provider configured with credential and verified when test succeeds", () => {
    const configured = getBuiltInProviderReadiness(
      "openai",
      { apiKey: "sk-test", enabled: true },
      null
    )
    const verified = getBuiltInProviderReadiness(
      "openai",
      { apiKey: "sk-test", enabled: true },
      { success: true, message: "ok" }
    )
    expect(configured.readiness).toBe("configured")
    expect(configured.verificationStatus).toBe("unverified")
    expect(verified.readiness).toBe("verified")
    expect(verified.verificationStatus).toBe("verified")
  })

  it("marks provider verification as stale when persisted fingerprint is out-of-date", () => {
    const stale = getBuiltInProviderReadiness(
      "openai",
      {
        apiKey: "sk-test-next",
        enabled: true,
        verificationStatus: "verified",
        verificationFingerprint: JSON.stringify({
          apiKey: "sk-old",
          apiKeys: [],
          currentKeyIndex: 0,
          baseURL: "",
          defaultModel: "gpt-4o",
        }),
      },
      null
    )

    expect(stale.verificationStatus).toBe("stale")
    expect(stale.setupChecklist.nextAction).toBe("verify_connection")
  })

  it("allows local provider test without credential when base url is present", () => {
    const state = getBuiltInProviderReadiness(
      "ollama",
      { baseURL: "http://localhost:11434", enabled: true },
      null
    )
    expect(state.readiness).toBe("configured")
    expect(state.eligibility.testConnection.allowed).toBe(true)
    expect(state.eligibility.enable.allowed).toBe(true)
  })

  it("blocks enabling when next state is enabled and requirements are missing", () => {
    const blocked = getProviderEnableEligibility("openai", { enabled: false }, true)
    const allowedDisable = getProviderEnableEligibility("openai", { enabled: true }, false)
    expect(blocked.allowed).toBe(false)
    expect(allowedDisable.allowed).toBe(true)
  })

  it("computes custom provider readiness and eligibility", () => {
    const unconfigured = getCustomProviderReadiness(
      { enabled: false, baseURL: "", apiKey: "" },
      null
    )
    const verified = getCustomProviderReadiness(
      { enabled: true, baseURL: "https://api.example.com/v1", apiKey: "sk-custom" },
      { success: true }
    )
    expect(unconfigured.readiness).toBe("unconfigured")
    expect(unconfigured.eligibility.testConnection.allowed).toBe(false)
    expect(verified.readiness).toBe("verified")
    expect(verified.verificationStatus).toBe("verified")
    expect(verified.eligibility.enable.allowed).toBe(true)
  })

  it("returns visible and selected provider intersection preserving visible order", () => {
    const result = getVisibleSelectedProviderIds(
      ["openai", "anthropic", "google"],
      new Set(["google", "openai", "non-visible"])
    )
    expect(result).toEqual(["openai", "google"])
  })

  it("builds visible + eligible targets for verify-enabled and retry-failed operations", () => {
    const visibleProviderIds = ["openai", "anthropic", "google"]
    const providerSettings = {
      openai: { apiKey: "sk-openai", enabled: true },
      anthropic: { apiKey: "", enabled: true },
      google: { apiKey: "sk-google", enabled: false },
    }
    const latestResults = {
      openai: { success: false, message: "failed" },
      anthropic: null,
      google: { success: false, message: "failed" },
    }

    expect(
      getVisibleEligibleBuiltInProviderIds(visibleProviderIds, providerSettings, latestResults)
    ).toEqual(["openai"])
    expect(
      getVisibleRetryFailedBuiltInProviderIds(visibleProviderIds, providerSettings, latestResults)
    ).toEqual(["openai"])
  })

  it("builds visible + eligible custom provider targets for verify-enabled and retry-failed", () => {
    const visibleCustomProviderIds = ["custom-a", "custom-b"]
    const customProviders = {
      "custom-a": {
        enabled: true,
        apiKey: "sk-custom-a",
        baseURL: "https://api.example.com/v1",
      },
      "custom-b": {
        enabled: true,
        apiKey: "",
        baseURL: "https://api.example.com/v1",
      },
    }
    const latestResults = {
      "custom-a": "error" as const,
      "custom-b": null,
    }

    expect(
      getVisibleEligibleCustomProviderIds(visibleCustomProviderIds, customProviders, latestResults)
    ).toEqual(["custom-a"])
    expect(
      getVisibleRetryFailedCustomProviderIds(
        visibleCustomProviderIds,
        customProviders,
        latestResults
      )
    ).toEqual(["custom-a"])
  })

  it("returns a chat runtime guard for built-in providers missing required credentials", () => {
    const guard = getChatRuntimeProviderGuard("openai", {
      providerSettings: {
        openai: { enabled: true, apiKey: "" },
      },
      customProviders: {},
    })

    expect(guard).toEqual({
      allowed: false,
      message: "API key not configured for openai. Please add your API key in Settings.",
    })
  })

  it("allows chat runtime when a local provider has the required base url", () => {
    const guard = getChatRuntimeProviderGuard("ollama", {
      providerSettings: {
        ollama: { enabled: true, baseURL: "http://localhost:11434" },
      },
      customProviders: {},
    })

    expect(guard).toEqual({ allowed: true })
  })

  it("formats the built-in runtime message for disabled providers", () => {
    expect(
      getBuiltinProviderChatRuntimeMessage("openai", { enabled: false, apiKey: "sk-test" })
    ).toBe("Provider openai is disabled. Please enable it in Settings.")
  })
})
