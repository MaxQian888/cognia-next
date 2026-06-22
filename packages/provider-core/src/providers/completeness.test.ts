import {
  buildProviderVerificationFingerprint,
  evaluateBuiltInProviderCompleteness,
  evaluateCustomProviderCompleteness,
  evaluateRuntimeEligibility,
  getActiveCredential,
  getProviderRequirements,
  hasAnyCredential,
  isValidHttpUrl,
} from "./completeness"

describe("provider completeness contract", () => {
  it("resolves active credentials from explicit keys and key pools", () => {
    expect(getActiveCredential({ apiKey: "  sk-direct  " })).toBe("sk-direct")
    expect(getActiveCredential({ apiKeys: ["", " sk-pool "], currentKeyIndex: 1 })).toBe("sk-pool")
    expect(getActiveCredential()).toBe("")
    expect(getActiveCredential({ apiKeys: [], currentKeyIndex: 0 })).toBe("")
    expect(getActiveCredential({ apiKeys: [" ", " sk-fallback "], currentKeyIndex: 0 })).toBe(
      "sk-fallback"
    )
    expect(getActiveCredential({ apiKeys: [" sk-first "], currentKeyIndex: 5 })).toBe("sk-first")
    expect(hasAnyCredential()).toBe(false)
    expect(hasAnyCredential({ apiKeys: undefined })).toBe(false)
    expect(hasAnyCredential({ apiKeys: [" ", "sk-pool"] })).toBe(true)
    expect(hasAnyCredential({ apiKeys: [" "] })).toBe(false)
  })

  it("validates only http and https base URLs", () => {
    expect(isValidHttpUrl("https://api.example.com/v1")).toBe(true)
    expect(isValidHttpUrl("http://localhost:11434")).toBe(true)
    expect(isValidHttpUrl()).toBe(false)
    expect(isValidHttpUrl("   ")).toBe(false)
    expect(isValidHttpUrl("ftp://example.com")).toBe(false)
    expect(isValidHttpUrl("not a url")).toBe(false)
  })

  it("builds stable fingerprints from trimmed optional settings", () => {
    expect(JSON.parse(buildProviderVerificationFingerprint()).apiKeys).toEqual([])

    const fingerprint = JSON.parse(
      buildProviderVerificationFingerprint({
        apiKey: " sk-direct ",
        apiKeys: [" key-a ", " key-b "],
        baseURL: " https://api.example.com/v1 ",
        defaultModel: " gpt-4o ",
      })
    )

    expect(fingerprint).toMatchObject({
      apiKey: "sk-direct",
      apiKeys: ["key-a", "key-b"],
      currentKeyIndex: 0,
      baseURL: "https://api.example.com/v1",
      defaultModel: "gpt-4o",
    })
  })

  it("infers requirements for catalog, local, and unknown providers", () => {
    expect(getProviderRequirements("openai")).toMatchObject({
      providerId: "openai",
      requiresCredential: true,
      isLocal: false,
    })
    expect(getProviderRequirements("ollama")).toMatchObject({
      providerId: "ollama",
      requiresCredential: false,
      isLocal: true,
    })
    expect(getProviderRequirements("missing-provider")).toMatchObject({
      providerId: "missing-provider",
      requiresCredential: true,
      requiresBaseUrl: true,
      isLocal: false,
    })
  })

  it("marks a verified built-in provider complete when its fingerprint matches", () => {
    const settings = {
      enabled: true,
      apiKey: "sk-test",
      defaultModel: "gpt-4o",
    }
    const verificationFingerprint = buildProviderVerificationFingerprint(settings)

    const result = evaluateBuiltInProviderCompleteness("openai", {
      ...settings,
      verificationStatus: "verified",
      verificationFingerprint,
    })

    expect(result.readiness).toBe("verified")
    expect(result.eligibility.testConnection.allowed).toBe(true)
    expect(result.setupChecklist.isComplete).toBe(true)
  })

  it("marks persisted verification stale when settings change or latest verification fails", () => {
    const previousFingerprint = buildProviderVerificationFingerprint({
      apiKey: "sk-old",
      defaultModel: "gpt-4o",
    })

    const changedSettings = evaluateBuiltInProviderCompleteness("openai", {
      enabled: true,
      apiKey: "sk-new",
      defaultModel: "gpt-4o",
      verificationStatus: "verified",
      verificationFingerprint: previousFingerprint,
    })
    expect(changedSettings.verificationStatus).toBe("stale")
    expect(changedSettings.setupChecklist.steps.at(-1)).toMatchObject({
      id: "verification",
      reason: "Provider configuration changed. Re-run verification.",
    })

    const failedLatest = evaluateBuiltInProviderCompleteness(
      "openai",
      {
        enabled: true,
        apiKey: "sk-test",
        defaultModel: "gpt-4o",
        verificationStatus: "verified",
      },
      { success: false }
    )
    expect(failedLatest.verificationStatus).toBe("stale")

    const staleLatest = evaluateBuiltInProviderCompleteness(
      "openai",
      {
        enabled: true,
        apiKey: "sk-test",
        defaultModel: "gpt-4o",
        verificationStatus: "stale",
      },
      { success: false }
    )
    expect(staleLatest.verificationStatus).toBe("stale")
  })

  it("keeps limited or non-authoritative latest results from marking providers verified", () => {
    const limited = evaluateBuiltInProviderCompleteness(
      "openai",
      { enabled: true, apiKey: "sk-test", defaultModel: "gpt-4o" },
      { success: true, outcome: "limited" }
    )
    expect(limited.verificationStatus).toBe("unverified")
    expect(limited.readiness).toBe("configured")

    const nonAuthoritative = evaluateBuiltInProviderCompleteness(
      "openai",
      { enabled: true, apiKey: "sk-test", defaultModel: "gpt-4o" },
      { success: true, authoritative: false }
    )
    expect(nonAuthoritative.verificationStatus).toBe("unverified")
  })

  it("blocks incomplete built-in and custom providers with actionable guards", () => {
    const builtIn = evaluateBuiltInProviderCompleteness("openai", { enabled: true })
    expect(builtIn.readiness).toBe("unconfigured")
    expect(builtIn.eligibility.testConnection).toMatchObject({
      allowed: false,
      nextAction: "add_api_key",
    })

    const custom = evaluateCustomProviderCompleteness({
      apiKey: "sk-test",
      baseURL: "ftp://invalid.example",
      enabled: true,
      defaultModel: "model-a",
    })
    expect(custom.eligibility.runtime).toMatchObject({
      allowed: false,
      nextAction: "configure_base_url",
    })
  })

  it("guards built-in providers that require explicit valid base URLs", () => {
    const missingBaseUrl = evaluateBuiltInProviderCompleteness("missing-provider", {
      enabled: true,
      apiKey: "sk-test",
      defaultModel: "model-a",
    })
    expect(missingBaseUrl.eligibility.enable).toMatchObject({
      code: "missing_base_url",
      nextAction: "configure_base_url",
    })
    expect(missingBaseUrl.eligibility.runtime).toMatchObject({
      code: "missing_base_url",
      nextAction: "configure_base_url",
    })

    const invalidBaseUrl = evaluateBuiltInProviderCompleteness("missing-provider", {
      enabled: true,
      apiKey: "sk-test",
      baseURL: "notaurl",
      defaultModel: "model-a",
    })
    expect(invalidBaseUrl.eligibility.testConnection).toMatchObject({
      code: "invalid_base_url",
      nextAction: "configure_base_url",
    })
    expect(invalidBaseUrl.eligibility.runtime).toMatchObject({
      code: "invalid_base_url",
      nextAction: "configure_base_url",
    })
    expect(
      invalidBaseUrl.setupChecklist.steps.find((step) => step.id === "base_url")
    ).toMatchObject({
      done: false,
      reason: "Configure a valid base URL before testing this provider.",
    })
  })

  it("covers custom provider setup, disabled runtime, and verification states", () => {
    expect(evaluateCustomProviderCompleteness(undefined).eligibility.enable).toMatchObject({
      code: "missing_credential",
    })

    const missingBaseUrl = evaluateCustomProviderCompleteness({
      apiKey: "sk-test",
      defaultModel: "model-a",
    })
    expect(missingBaseUrl.eligibility.enable).toMatchObject({ code: "missing_base_url" })
    expect(missingBaseUrl.eligibility.runtime).toMatchObject({ code: "missing_base_url" })

    const disabledVerified = evaluateCustomProviderCompleteness(
      {
        apiKey: "sk-test",
        baseURL: "https://custom.example/v1",
        defaultModel: "model-a",
        enabled: false,
      },
      { success: true }
    )
    expect(disabledVerified.readiness).toBe("verified")
    expect(disabledVerified.eligibility.runtime).toMatchObject({ code: "provider_disabled" })
    expect(disabledVerified.setupChecklist.isComplete).toBe(true)

    const configured = evaluateCustomProviderCompleteness({
      apiKey: "sk-test",
      baseURL: "https://custom.example/v1",
      defaultModel: "model-a",
    })
    expect(configured.readiness).toBe("configured")
    expect(configured.eligibility.enable.allowed).toBe(true)
  })

  it("exposes runtime eligibility as the built-in runtime guard", () => {
    expect(
      evaluateRuntimeEligibility("openai", { enabled: false, apiKey: "sk-test" })
    ).toMatchObject({
      allowed: false,
      code: "provider_disabled",
    })
  })
})
