import {
  getBuiltInProviderReadiness,
  getChatRuntimeProviderGuard,
  getCustomProviderReadiness,
  getProviderEnableEligibility,
  getVisibleEligibleBuiltInProviderIds,
  getVisibleEligibleCustomProviderIds,
  getVisibleRetryFailedBuiltInProviderIds,
  getVisibleRetryFailedCustomProviderIds,
  getVisibleSelectedProviderIds,
} from "./readiness"
import { buildProviderVerificationFingerprint } from "./completeness"

describe("provider readiness wrappers", () => {
  it("allows disabling but blocks enabling incomplete built-in providers", () => {
    expect(getProviderEnableEligibility("openai", undefined, false).allowed).toBe(true)
    expect(getProviderEnableEligibility("openai", undefined, true)).toMatchObject({
      allowed: false,
      nextAction: "add_api_key",
    })
  })

  it("projects built-in and custom readiness from the shared completeness contract", () => {
    const settings = { enabled: true, apiKey: "sk-test", defaultModel: "gpt-4o" }
    const verificationFingerprint = buildProviderVerificationFingerprint(settings)
    const builtIn = getBuiltInProviderReadiness("openai", {
      ...settings,
      verificationStatus: "verified",
      verificationFingerprint,
    })
    expect(builtIn.readiness).toBe("verified")

    const custom = getCustomProviderReadiness({
      apiKey: "sk-test",
      baseURL: "https://api.example.com/v1",
      enabled: true,
      defaultModel: "model-a",
    })
    expect(custom.readiness).toBe("configured")
    expect(custom.eligibility.enable.allowed).toBe(true)
  })

  it("returns runtime guard messages for disabled or unconfigured providers", () => {
    expect(
      getChatRuntimeProviderGuard("openai", {
        providerSettings: { openai: { enabled: false } },
        customProviders: {},
      })
    ).toMatchObject({ allowed: false })

    expect(
      getChatRuntimeProviderGuard("custom", {
        providerSettings: {},
        customProviders: { custom: { enabled: true, baseURL: "https://api.example.com/v1" } },
      })
    ).toMatchObject({ allowed: false })
  })

  it("filters visible provider ids by selection, eligibility, and retry state", () => {
    const visible = ["openai", "anthropic", "missing"]
    const providerSettings = {
      openai: { enabled: true, apiKey: "sk-openai", defaultModel: "gpt-4o" },
      anthropic: { enabled: false, apiKey: "sk-anthropic" },
    }

    expect(getVisibleSelectedProviderIds(visible, new Set(["openai", "missing"]))).toEqual([
      "openai",
      "missing",
    ])
    expect(getVisibleEligibleBuiltInProviderIds(visible, providerSettings, {})).toEqual(["openai"])
    expect(
      getVisibleRetryFailedBuiltInProviderIds(visible, providerSettings, {
        openai: { success: false, message: "failed" },
      })
    ).toEqual(["openai"])

    const customProviders = {
      customA: {
        enabled: true,
        apiKey: "sk-test",
        baseURL: "https://api.example.com/v1",
        defaultModel: "model-a",
      },
      customB: { enabled: false, apiKey: "sk-test", baseURL: "https://api.example.com/v1" },
    }
    expect(
      getVisibleEligibleCustomProviderIds(["customA", "customB"], customProviders, {})
    ).toEqual(["customA"])
    expect(
      getVisibleRetryFailedCustomProviderIds(["customA", "customB"], customProviders, {
        customA: "error",
      })
    ).toEqual(["customA"])
  })
})
