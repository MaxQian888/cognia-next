/** @jest-environment jsdom */
import {
  catalogEntryToProviderConfig,
  getAllProviders,
  getBuiltInProviderCatalog,
} from "@cognia/provider-types"

import {
  OAUTH_PROVIDERS,
  buildOAuthUrl,
  buildOAuthExchangeRequest,
  clearOAuthState,
  exchangeCodeForApiKey,
  extractOAuthExchangeResult,
  generateCodeChallenge,
  generateCodeVerifier,
  getOAuthCallbackQueryKeys,
  getOAuthState,
  getProviderOAuthConfig,
  isOAuthCredentialExpiring,
  parseOAuthCallback,
  refreshOAuthCredential,
  saveOAuthState,
  verifyOAuthState,
  type OAuthState,
  buildNativeOAuthRedirectUri,
  parseNativeOAuthDeepLink,
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
    // OpenRouter's PKCE flow has no scope parameter.
    expect(parsed.searchParams.get("scope")).toBeNull()
    expect(parsed.searchParams.get("code_challenge")).toBeTruthy()
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256")
    // OpenRouter names the redirect target `callback_url`; the default
    // resolves the static-export settings route against the current origin.
    expect(parsed.searchParams.get("callback_url")).toBe(
      "http://localhost/settings?section=providers&oauthProvider=openrouter"
    )
    expect(getOAuthState()).toMatchObject({
      providerId: "openrouter",
      state: result!.state.state,
      redirectUri: "http://localhost/settings?section=providers&oauthProvider=openrouter",
    })
  })

  it("uses a host-supplied redirect URI (native deep link) when given", async () => {
    const redirectUri = buildNativeOAuthRedirectUri("openrouter")
    expect(redirectUri).toBe("cognia://provider/oauth/openrouter")
    const result = await buildOAuthUrl("openrouter", { redirectUri })
    const parsed = new URL(result!.url)
    expect(parsed.searchParams.get("callback_url")).toBe(redirectUri)
    expect(getOAuthState()?.redirectUri).toBe(redirectUri)
    expect(parseNativeOAuthDeepLink("cognia://provider/oauth/openrouter?code=abc&state=s")).toEqual(
      {
        providerId: "openrouter",
        search: expect.any(URLSearchParams),
      }
    )
    expect(
      parseNativeOAuthDeepLink("cognia://provider/oauth/openrouter?code=abc")?.search.get("code")
    ).toBe("abc")
    expect(parseNativeOAuthDeepLink("cognia://connector/oauth/slack?code=x")).toBeNull()
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

    // OpenRouter answers `{ key }` — the catalog's response mapping reads it.
    expect(extractOAuthExchangeResult("openrouter", { key: "sk-or-test" })).toMatchObject({
      apiKey: "sk-or-test",
    })
    expect(extractOAuthExchangeResult("openrouter", { key: "" })).toBeNull()
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

  it("exchanges callback codes directly against the token endpoint and reports failures as null", async () => {
    fetchMock.mockResolvedValueOnce(response({ key: "sk-key" }))
    await expect(
      exchangeCodeForApiKey("openrouter", { code: "abc", codeVerifier: "ver" })
    ).resolves.toEqual({ apiKey: "sk-key", expiresAt: undefined })
    // No `/api/oauth/*` route exists in the static export — the exchange goes
    // to the provider's `tokenUrl` with the PKCE verifier.
    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "abc", code_verifier: "ver", code_challenge_method: "S256" }),
    })

    fetchMock.mockResolvedValueOnce(response({ error: "denied" }, 400))
    await expect(exchangeCodeForApiKey("openrouter", { code: "bad" })).resolves.toBeNull()

    fetchMock.mockRejectedValueOnce(new Error("network down"))
    await expect(exchangeCodeForApiKey("openrouter", { code: "bad" })).resolves.toBeNull()
  })

  it("reports a credential as expiring only inside the buffer", () => {
    const now = 1_000_000
    expect(isOAuthCredentialExpiring(now + 60 * 60_000, now)).toBe(false)
    expect(isOAuthCredentialExpiring(now + 60_000, now)).toBe(true)
    expect(isOAuthCredentialExpiring(now - 1, now)).toBe(true)
  })

  it("treats a credential with no stated expiry as non-expiring", () => {
    // OpenRouter mints a long-lived key with no expiry. Renewing it on a
    // schedule would be churn against a credential that never goes stale.
    expect(isOAuthCredentialExpiring(undefined, 1_000_000)).toBe(false)
    expect(isOAuthCredentialExpiring(Number.NaN, 1_000_000)).toBe(false)
  })

  it("returns null for a provider that declares no refresh spec", async () => {
    // OpenRouter has no `refresh` block, so there is nothing to spend a token
    // on. The caller must treat this as "re-login", never as "retry".
    await expect(refreshOAuthCredential("openrouter", { refreshToken: "rt-1" })).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns null when there is no refresh token to spend", async () => {
    await expect(refreshOAuthCredential("openrouter", { refreshToken: "" })).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns null for an unknown provider", async () => {
    await expect(refreshOAuthCredential("nope", { refreshToken: "rt-1" })).resolves.toBeNull()
  })
})

describe("the OAuth wiring a catalog entry has to survive", () => {
  it("never routes a callback through a path the static export deletes", () => {
    // `app/api/` does not exist at runtime. A callback pointing there answers
    // 404 after the user has already approved, which reads as the provider
    // rejecting them. The openrouter catalog entry shipped exactly that, and
    // was saved only by an inline duplicate that happened to shadow it.
    const routed = Object.values(getAllProviders())
      .filter((provider) => provider.oauthConfig)
      .map((provider) => ({ id: provider.id, path: provider.oauthConfig?.callbackPath ?? "" }))
      .filter((entry) => entry.path.startsWith("/api/"))
    expect(routed).toEqual([])
  })

  it("carries both OAuth fields through the catalog converter", () => {
    // The login button gates on `supportsOAuth` and the flow gates on
    // `oauthConfig`. The converter copies field by name, so a field nobody
    // listed is dropped in silence and the provider simply renders no login.
    const entry = getBuiltInProviderCatalog().find((candidate) => candidate.oauthConfig)
    expect(entry).toBeDefined()
    const converted = catalogEntryToProviderConfig(entry!)
    expect(converted.supportsOAuth).toBe(entry!.supportsOAuth)
    expect(converted.oauthConfig).toEqual(entry!.oauthConfig)
  })
})
