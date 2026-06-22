import {
  deriveVerificationStatusFromConnectivityResult,
  resolveBuiltInProviderConnectivityTarget,
  resolveCustomProviderConnectivityTarget,
} from "./connectivity"

describe("resolveBuiltInProviderConnectivityTarget", () => {
  it("normalizes built-in provider credentials and requirements", () => {
    expect(
      resolveBuiltInProviderConnectivityTarget("openai", {
        apiKey: "  sk-openai  ",
        enabled: true,
      })
    ).toMatchObject({
      providerId: "openai",
      protocol: "openai",
      apiKey: "sk-openai",
      requiresCredential: true,
      requiresBaseURL: false,
      isLocal: false,
    })
  })
})

describe("resolveCustomProviderConnectivityTarget", () => {
  it("normalizes custom provider base URL and protocol defaults", () => {
    expect(
      resolveCustomProviderConnectivityTarget("custom-openai", {
        apiKey: " custom-key ",
        baseURL: " https://gateway.example/v1 ",
        enabled: true,
      })
    ).toMatchObject({
      providerId: "custom-openai",
      protocol: "openai",
      apiKey: "custom-key",
      baseURL: "https://gateway.example/v1",
      requiresCredential: true,
      requiresBaseURL: true,
      isLocal: false,
    })
  })
})

describe("deriveVerificationStatusFromConnectivityResult", () => {
  it("marks authoritative successful checks as verified", () => {
    expect(
      deriveVerificationStatusFromConnectivityResult("unverified", {
        success: true,
        outcome: "verified",
      })
    ).toBe("verified")
  })

  it("downgrades a previously verified provider to stale after non-authoritative or failed checks", () => {
    expect(
      deriveVerificationStatusFromConnectivityResult("verified", {
        success: true,
        authoritative: false,
      })
    ).toBe("stale")
    expect(deriveVerificationStatusFromConnectivityResult("verified", { success: false })).toBe(
      "stale"
    )
  })
})
