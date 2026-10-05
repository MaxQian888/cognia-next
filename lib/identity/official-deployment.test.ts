import {
  OFFICIAL_AUDIENCE_DEFAULT,
  OFFICIAL_ISSUER_DEFAULT,
  OFFICIAL_NATIVE_CLIENT_ID,
  OFFICIAL_SYNC_URL_DEFAULT,
  OFFICIAL_WEB_CLIENT_ID,
  isOfficialIssuer,
  isOfficialSocialProvider,
  officialAccountEnabled,
  officialDeployment,
  officialLogtoConfig,
  officialSyncUrl,
} from "./official-deployment"

describe("officialDeployment", () => {
  it("defaults to production with both first-party clients", () => {
    expect(officialDeployment({})).toEqual({
      kind: "official",
      issuer: OFFICIAL_ISSUER_DEFAULT,
      audience: OFFICIAL_AUDIENCE_DEFAULT,
      nativeClientId: "cognia-app",
      webClientId: "cognia-web",
      issuerKind: "oidc",
      social: ["feishu", "github", "google", "apple"],
    })
  })

  it("takes a build's issuer and audience, without a trailing slash", () => {
    const deployment = officialDeployment({
      issuer: " http://localhost:8787/api/auth/ ",
      audience: "https://sync-staging.cognia.cn",
    })
    expect(deployment?.issuer).toBe("http://localhost:8787/api/auth")
    expect(deployment?.audience).toBe("https://sync-staging.cognia.cn")
  })

  it("ignores an override that is not an http(s) URL", () => {
    expect(officialDeployment({ issuer: "javascript:alert(1)" })?.issuer).toBe(
      OFFICIAL_ISSUER_DEFAULT
    )
    expect(officialDeployment({ issuer: "not a url" })?.issuer).toBe(OFFICIAL_ISSUER_DEFAULT)
  })

  it("is switched off by the self-hosted build flag", () => {
    for (const enabled of ["0", "false", "OFF"]) {
      expect(officialAccountEnabled({ enabled })).toBe(false)
      expect(officialDeployment({ enabled })).toBeNull()
    }
    expect(officialAccountEnabled({ enabled: "1" })).toBe(true)
    expect(officialAccountEnabled({})).toBe(true)
  })
})

describe("officialLogtoConfig", () => {
  const deployment = officialDeployment({})!

  it("uses the native client with the provider hint", () => {
    expect(
      officialLogtoConfig(deployment, {
        redirectUri: "cn.cognia.app:/auth/callback",
        clientKind: "native",
        socialProvider: "feishu",
      })
    ).toEqual({
      issuer: OFFICIAL_ISSUER_DEFAULT,
      clientId: OFFICIAL_NATIVE_CLIENT_ID,
      redirectUri: "cn.cognia.app:/auth/callback",
      resource: OFFICIAL_AUDIENCE_DEFAULT,
      scopes: ["profile", "email"],
      issuerKind: "oidc",
      socialProvider: "feishu",
    })
  })

  it("uses the web client and asks for a fresh login when told to", () => {
    const config = officialLogtoConfig(deployment, {
      redirectUri: "https://app.cognia.cn/logto/callback",
      clientKind: "web",
      freshLogin: true,
    })
    expect(config.clientId).toBe(OFFICIAL_WEB_CLIENT_ID)
    expect(config.freshLogin).toBe(true)
    expect(config.socialProvider).toBeUndefined()
    // Organizations are a Logto concept the official issuer does not have.
    expect(config.organizationId).toBeUndefined()
  })
})

describe("helpers", () => {
  it("recognises the official issuer and its providers", () => {
    const deployment = officialDeployment({})
    expect(isOfficialIssuer(`${OFFICIAL_ISSUER_DEFAULT}/`, deployment)).toBe(true)
    expect(isOfficialIssuer("https://logto.example.com/oidc", deployment)).toBe(false)
    expect(isOfficialIssuer(OFFICIAL_ISSUER_DEFAULT, null)).toBe(false)
    expect(isOfficialSocialProvider("apple")).toBe(true)
    expect(isOfficialSocialProvider("wechat")).toBe(false)
  })
})

describe("officialSyncUrl", () => {
  it("defaults to the official sync Worker and takes a build override", () => {
    expect(officialSyncUrl(undefined)).toBe(OFFICIAL_SYNC_URL_DEFAULT)
    expect(officialSyncUrl("")).toBe(OFFICIAL_SYNC_URL_DEFAULT)
    expect(officialSyncUrl("https://sync-staging.cognia.cn/")).toBe(
      "https://sync-staging.cognia.cn"
    )
    expect(officialSyncUrl("http://localhost:8788")).toBe("http://localhost:8788")
    expect(officialSyncUrl("ftp://nope")).toBe(OFFICIAL_SYNC_URL_DEFAULT)
  })
})
