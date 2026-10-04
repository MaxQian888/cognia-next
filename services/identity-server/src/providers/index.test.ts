import { describe, expect, it } from "vitest"

import { providerSetup } from "./index"

describe("providerSetup", () => {
  it("offers nothing without credentials", () => {
    expect(providerSetup({ providers: {} })).toEqual({ socialProviders: {}, plugins: [] })
  })

  it("configures each provider for identity only", () => {
    const setup = providerSetup(
      {
        providers: {
          github: { clientId: "gh", clientSecret: "ghs" },
          google: { clientId: "go", clientSecret: "gos" },
          apple: {
            serviceId: "svc",
            teamId: "t",
            keyId: "k",
            privateKey: "p",
            appBundleId: "com.cognia.mobile",
          },
          feishu: { appId: "cli", appSecret: "fs" },
        },
      },
      { appleClientSecret: "minted" }
    )
    expect(setup.socialProviders.github).toEqual({ clientId: "gh", clientSecret: "ghs" })
    expect(setup.socialProviders.google).toMatchObject({ clientId: "go", accessType: "online" })
    expect(setup.socialProviders.apple).toEqual({
      clientId: "svc",
      clientSecret: "minted",
      appBundleIdentifier: "com.cognia.mobile",
    })
    // Feishu is not OIDC and rides on genericOAuth.
    expect(setup.plugins).toHaveLength(1)
  })

  it("refuses Apple without a minted secret", () => {
    expect(() =>
      providerSetup({
        providers: { apple: { serviceId: "s", teamId: "t", keyId: "k", privateKey: "p" } },
      })
    ).toThrow(/client secret/)
  })
})
