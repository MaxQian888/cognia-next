import {
  OAUTH_PROVIDERS,
  buildOAuthUrl,
  buildOAuthExchangeRequest,
  clearOAuthState,
  clearTokenExpiry,
  ensureValidToken,
  exchangeCodeForApiKey,
  extractOAuthExchangeResult,
  generateCodeChallenge,
  generateCodeVerifier,
  getOAuthCallbackQueryKeys,
  getOAuthState,
  getProviderOAuthConfig,
  getTokenExpiry,
  getTokenTimeToExpiry,
  isTokenExpired,
  isTokenExpiringSoon,
  parseOAuthCallback,
  refreshOAuthToken,
  saveOAuthState,
  saveTokenExpiry,
  verifyOAuthState,
  type OAuthState,
} from "./oauth"

const fetchMock = jest.fn()

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe("OAuth provider helpers", () => {
  beforeEach(() => {
    localStorage.clear()
    fetchMock.mockReset()
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
    jest.useRealTimers()
  })

  it("discovers OpenRouter OAuth config and callback extraction keys", () => {
    expect(OAUTH_PROVIDERS.openrouter.providerId).toBe("openrouter")
    expect(getProviderOAuthConfig("openrouter")).toMatchObject({
      providerId: "openrouter",
      pkceRequired: true,
      tokenUrl: "https://openrouter.ai/api/v1/auth/keys",
    })
    expect(getOAuthCallbackQueryKeys("openrouter")).toEqual(
      expect.arrayContaining(["code", "state"])
    )
    expect(parseOAuthCallback("openrouter", "?code=abc&state=xyz")).toMatchObject({
      code: "abc",
      state: "xyz",
    })
    expect(getProviderOAuthConfig("missing")).toBeNull()
  })

  it("generates PKCE verifier/challenge values and builds the OpenRouter auth URL", async () => {
    const verifier = generateCodeVerifier()
    const challenge = await generateCodeChallenge(verifier)

    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)

    const result = await buildOAuthUrl("openrouter")
    expect(result).not.toBeNull()

    const parsed = new URL(result!.url)
    expect(parsed.origin).toBe("https://openrouter.ai")
    expect(parsed.pathname).toBe("/auth")
    expect(parsed.searchParams.get("state")).toBe(result!.state.state)
    expect(parsed.searchParams.get("scope")).toBe("openid profile")
    expect(parsed.searchParams.get("code_challenge")).toBeTruthy()
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256")
    expect(getOAuthState()).toMatchObject({
      providerId: "openrouter",
      state: result!.state.state,
      redirectUri: "http://localhost/api/oauth/openrouter/callback",
    })
  })

  it("returns empty results for providers without OAuth support", async () => {
    await expect(buildOAuthUrl("missing")).resolves.toBeNull()
    expect(parseOAuthCallback("missing", "?code=abc")).toBeNull()
    expect(getOAuthCallbackQueryKeys("missing")).toEqual([])
    expect(buildOAuthExchangeRequest("missing", { code: "abc" })).toBeNull()
    expect(extractOAuthExchangeResult("missing", { apiKey: "sk" })).toBeNull()
  })

  it("builds exchange requests and extracts exchange responses from config rules", () => {
    const request = buildOAuthExchangeRequest("openrouter", {
      code: "abc",
      codeVerifier: "verifier",
      redirectUri: "http://localhost/api/oauth/openrouter/callback",
    })

    expect(request?.url).toBe("https://openrouter.ai/api/v1/auth/keys")
    expect(request?.init.method).toBe("POST")
    expect(request?.init.headers).toMatchObject({ "Content-Type": "application/json" })

    expect(
      extractOAuthExchangeResult("openrouter", { apiKey: "sk-or-test", expiresAt: "123" })
    ).toMatchObject({ apiKey: "sk-or-test", expiresAt: 123 })
    expect(extractOAuthExchangeResult("openrouter", { apiKey: "" })).toBeNull()
  })

  it("applies custom OAuth rule maps, transforms, callback extraction, and GET exchange requests", async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@cognia/provider-types", () => ({
        getAllProviders: () => ({
          "unit-oauth": {
            id: "unit-oauth",
            name: "unit-oauth",
            type: "cloud",
            apiKeyRequired: true,
            baseURLRequired: false,
            defaultModel: "unit-model",
            models: [],
            supportsOAuth: true,
            oauthConfig: {
              authorizationUrl: "https://unit.example/auth",
              tokenUrl: "https://unit.example/token",
              callbackPath: "/oauth/callback",
              pkceRequired: false,
              authorizationParams: {
                state: { from: "runtime.state" },
                provider: { from: "runtime.providerId" },
                enabled: { literal: "1", transforms: ["to-boolean", "to-string"] },
                omitted: { from: "runtime.missing" },
              },
              callback: {
                extract: {
                  code: "query.oauth_code",
                  state: "query.s",
                  missing: "query.none",
                },
              },
              exchange: {
                method: "GET",
                headers: {
                  "X-Code": { from: "input.code", transforms: ["to-string"] },
                  "X-Count": { from: "input.count", transforms: ["to-number", "to-string"] },
                  "X-Enabled": { from: "input.enabled", transforms: ["to-boolean", "to-string"] },
                  "X-Omitted": { from: "input.empty" },
                },
                body: {
                  ignored: { literal: "not-sent" },
                },
                response: {
                  apiKey: "body.payload.key",
                  expiresAt: "body.payload.expires",
                  limited: "body.payload.limited",
                  missing: "body.payload.none",
                },
              },
            },
          },
        }),
      }))
      const {
        buildOAuthExchangeRequest: buildUnitOAuthExchangeRequest,
        buildOAuthUrl: buildUnitOAuthUrl,
        extractOAuthExchangeResult: extractUnitOAuthExchangeResult,
        getOAuthCallbackQueryKeys: getUnitOAuthCallbackQueryKeys,
        parseOAuthCallback: parseUnitOAuthCallback,
      } = await import("./oauth")

      try {
        const auth = await buildUnitOAuthUrl("unit-oauth")
        expect(auth).not.toBeNull()
        const authUrl = new URL(auth!.url)
        expect(authUrl.searchParams.get("provider")).toBe("unit-oauth")
        expect(authUrl.searchParams.get("enabled")).toBe("true")
        expect(authUrl.searchParams.has("omitted")).toBe(false)
        expect(authUrl.searchParams.has("code_challenge")).toBe(false)

        expect(
          parseUnitOAuthCallback("unit-oauth", new URLSearchParams("oauth_code=abc&s=state-1"))
        ).toEqual({
          code: "abc",
          state: "state-1",
          missing: null,
        })
        expect(getUnitOAuthCallbackQueryKeys("unit-oauth").sort()).toEqual([
          "none",
          "oauth_code",
          "s",
        ])

        const request = buildUnitOAuthExchangeRequest("unit-oauth", {
          code: 123,
          count: "5",
          enabled: true,
          empty: "",
        })
        expect(request?.init.method).toBe("GET")
        expect(request?.init.body).toBeUndefined()
        expect(request?.init.headers).toMatchObject({
          "X-Code": "123",
          "X-Count": "5",
          "X-Enabled": "true",
        })
        expect((request?.init.headers as Record<string, string>)["X-Omitted"]).toBeUndefined()

        expect(
          extractUnitOAuthExchangeResult("unit-oauth", {
            payload: { key: "sk-unit", expires: 123, limited: false },
          })
        ).toEqual({ apiKey: "sk-unit", expiresAt: 123, limited: false })
      } finally {
        jest.dontMock("@cognia/provider-types")
      }
    })
  })

  it("stores, verifies, and clears OAuth state", () => {
    const state: OAuthState = {
      state: "state-1",
      codeVerifier: "verifier",
      providerId: "openrouter",
      redirectUri: "http://localhost/callback",
      createdAt: Date.now(),
    }

    saveOAuthState(state)
    expect(getOAuthState()).toEqual(state)
    expect(verifyOAuthState("state-1")).toEqual(state)
    expect(verifyOAuthState("different")).toBeNull()

    clearOAuthState()
    expect(getOAuthState()).toBeNull()
  })

  it("drops malformed and expired OAuth state records", () => {
    localStorage.setItem("cognia-oauth-state", "{bad json")
    expect(getOAuthState()).toBeNull()

    saveOAuthState({
      state: "expired",
      codeVerifier: "verifier",
      providerId: "openrouter",
      redirectUri: "http://localhost/callback",
      createdAt: Date.now() - 11 * 60 * 1000,
    })
    expect(getOAuthState()).toBeNull()
    expect(localStorage.getItem("cognia-oauth-state")).toBeNull()
  })

  it("exchanges callback codes through the API route and reports failures as null", async () => {
    fetchMock.mockResolvedValueOnce(response({ key: "sk-key", expiresAt: 123 }))
    await expect(exchangeCodeForApiKey("openrouter", { code: "abc" })).resolves.toEqual({
      apiKey: "sk-key",
      expiresAt: 123,
    })
    expect(fetchMock).toHaveBeenCalledWith("/api/oauth/openrouter/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "abc" }),
    })

    fetchMock.mockResolvedValueOnce(response({ error: "denied" }, 400))
    await expect(exchangeCodeForApiKey("openrouter", { code: "bad" })).resolves.toBeNull()

    fetchMock.mockRejectedValueOnce(new Error("network down"))
    await expect(exchangeCodeForApiKey("openrouter", { code: "bad" })).resolves.toBeNull()
  })

  it("tracks token expiry and refreshes when a token is near expiry", async () => {
    const farFuture = Date.now() + 60 * 60 * 1000
    saveTokenExpiry("openrouter", farFuture, "refresh-token")
    expect(getTokenExpiry("openrouter")).toMatchObject({ providerId: "openrouter" })
    expect(isTokenExpired("openrouter")).toBe(false)
    expect(isTokenExpiringSoon("openrouter")).toBe(false)
    expect(getTokenTimeToExpiry("openrouter")).toBeGreaterThan(0)
    await expect(ensureValidToken("openrouter")).resolves.toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()

    saveTokenExpiry("openrouter", Date.now() + 60 * 1000, "refresh-token")
    fetchMock.mockResolvedValueOnce(response({ apiKey: "sk-refreshed", expiresAt: farFuture }))
    const onRefresh = jest.fn()
    await expect(ensureValidToken("openrouter", onRefresh)).resolves.toBe(true)
    expect(onRefresh).toHaveBeenCalledWith("sk-refreshed")

    clearTokenExpiry("openrouter")
    expect(getTokenExpiry("openrouter")).toBeNull()
  })

  it("handles malformed, missing, expired, and zero-remaining token expiry records", () => {
    localStorage.setItem("cognia-oauth-token-expiry-openrouter", "{bad json")
    expect(getTokenExpiry("openrouter")).toBeNull()
    expect(isTokenExpiringSoon("missing")).toBe(false)
    expect(isTokenExpired("missing")).toBe(false)
    expect(getTokenTimeToExpiry("missing")).toBeNull()

    saveTokenExpiry("openrouter", Date.now() - 1)
    expect(isTokenExpiringSoon("openrouter")).toBe(true)
    expect(isTokenExpired("openrouter")).toBe(true)
    expect(getTokenTimeToExpiry("openrouter")).toBe(0)
  })

  it("refreshes OAuth tokens directly and preserves refresh tokens when the response omits one", async () => {
    const farFuture = Date.now() + 60 * 60 * 1000
    saveTokenExpiry("openrouter", Date.now() + 60 * 1000, "refresh-token")
    fetchMock.mockResolvedValueOnce(response({ key: "sk-refreshed" }))
    await expect(refreshOAuthToken("openrouter")).resolves.toEqual({
      apiKey: "sk-refreshed",
      expiresAt: undefined,
    })

    fetchMock.mockResolvedValueOnce(
      response({ apiKey: "sk-refreshed-again", expiresAt: farFuture }, 200)
    )
    await expect(refreshOAuthToken("openrouter")).resolves.toEqual({
      apiKey: "sk-refreshed-again",
      expiresAt: farFuture,
    })
    expect(getTokenExpiry("openrouter")).toMatchObject({
      expiresAt: farFuture,
      refreshToken: "refresh-token",
    })
  })

  it("returns null when refresh tokens are missing or refresh requests fail", async () => {
    saveTokenExpiry("openrouter", Date.now() + 60 * 1000)
    await expect(refreshOAuthToken("openrouter")).resolves.toBeNull()

    saveTokenExpiry("openrouter", Date.now() + 60 * 1000, "refresh-token")
    fetchMock.mockResolvedValueOnce(response({ message: "denied" }, 401))
    await expect(refreshOAuthToken("openrouter")).resolves.toBeNull()

    fetchMock.mockRejectedValueOnce(new Error("offline"))
    await expect(refreshOAuthToken("openrouter")).resolves.toBeNull()
  })

  it("logs the expired-token path and returns false when proactive refresh fails", async () => {
    saveTokenExpiry("openrouter", Date.now() - 1000, "refresh-token")
    fetchMock.mockResolvedValueOnce(
      response({ apiKey: "sk-expired", expiresAt: Date.now() + 60 * 60 * 1000 })
    )
    await expect(ensureValidToken("openrouter")).resolves.toBe(true)

    saveTokenExpiry("openrouter", Date.now() + 60 * 1000, "refresh-token")
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    await expect(ensureValidToken("openrouter")).resolves.toBe(false)
  })
})
