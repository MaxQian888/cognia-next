// Unit tests for the OAuth helpers. The PKCE primitives we depend on
// (`generateCodeVerifier` / `generateCodeChallenge`) come from the existing
// `lib/ai/providers/oauth.ts`, so we don't re-test them here — the tests
// focus on shape + form encoding + error paths.

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  extractAuthorizationCode,
  isAnthropicCredentialFresh,
  refreshAccessToken,
} from "./oauth"
import { CLAUDE_OAUTH_CLIENT_ID, OAUTH_ENDPOINTS } from "./constants"

describe("buildAuthorizeUrl", () => {
  it("targets claude.ai for subscription mode and embeds PKCE", async () => {
    const { url, flowState } = await buildAuthorizeUrl({ mode: "subscription" })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe(OAUTH_ENDPOINTS.subscription.authorizeUrl)
    expect(parsed.searchParams.get("client_id")).toBe(CLAUDE_OAUTH_CLIENT_ID)
    expect(parsed.searchParams.get("redirect_uri")).toBe(OAUTH_ENDPOINTS.subscription.redirectUri)
    expect(parsed.searchParams.get("scope")).toBe(OAUTH_ENDPOINTS.subscription.scopes)
    expect(parsed.searchParams.get("response_type")).toBe("code")
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256")
    expect(parsed.searchParams.get("code")).toBe("true")
    expect(parsed.searchParams.get("code_challenge")?.length).toBeGreaterThan(20)
    expect(parsed.searchParams.get("state")?.length).toBeGreaterThan(10)
    expect(flowState.codeVerifier.length).toBeGreaterThan(20)
    expect(flowState.mode).toBe("subscription")
    expect(flowState.redirectUri).toBe(OAUTH_ENDPOINTS.subscription.redirectUri)
  })

  it("targets console.anthropic.com for console mode", async () => {
    const { url } = await buildAuthorizeUrl({ mode: "console" })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe(OAUTH_ENDPOINTS.console.authorizeUrl)
    expect(parsed.searchParams.get("scope")).toBe(OAUTH_ENDPOINTS.console.scopes)
  })

  it("issues a fresh state + verifier per call", async () => {
    const a = await buildAuthorizeUrl({ mode: "subscription" })
    const b = await buildAuthorizeUrl({ mode: "subscription" })
    expect(a.flowState.state).not.toBe(b.flowState.state)
    expect(a.flowState.codeVerifier).not.toBe(b.flowState.codeVerifier)
  })
})

describe("extractAuthorizationCode", () => {
  it("returns null on empty input", () => {
    expect(extractAuthorizationCode("")).toBeNull()
    expect(extractAuthorizationCode("   ")).toBeNull()
  })

  it("parses a bare code", () => {
    expect(extractAuthorizationCode("ABC123")).toEqual({ code: "ABC123" })
  })

  it("parses a code#state shape", () => {
    expect(extractAuthorizationCode("ABC123#STATE-XYZ")).toEqual({
      code: "ABC123",
      state: "STATE-XYZ",
    })
  })

  it("parses a full callback URL", () => {
    const url = "https://platform.claude.com/oauth/code/callback?code=XYZ789&state=ST"
    expect(extractAuthorizationCode(url)).toEqual({ code: "XYZ789", state: "ST" })
  })

  it("returns null on a URL without a code", () => {
    expect(
      extractAuthorizationCode("https://platform.claude.com/oauth/code/callback?state=foo")
    ).toBeNull()
  })

  it("returns null on a malformed URL", () => {
    expect(extractAuthorizationCode("https://[broken")).toBeNull()
  })
})

describe("exchangeCodeForTokens", () => {
  const flowState = {
    state: "fixed-state",
    codeVerifier: "fixed-verifier",
    mode: "subscription" as const,
    redirectUri: OAUTH_ENDPOINTS.subscription.redirectUri,
  }

  it("posts form-encoded grant_type=authorization_code and unpacks the response", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "oat01-aaa",
        refresh_token: "rt-bbb",
        expires_in: 3600,
        scope: "user:profile user:inference",
        account: { email: "u@example.com", plan: "pro" },
      }),
    })
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch

    const credential = await exchangeCodeForTokens({ code: "AUTHCODE", flowState })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchMock.mock.calls[0]
    expect(calledUrl).toBe("https://platform.claude.com/v1/oauth/token")
    expect(init.method).toBe("POST")
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded")

    const params = new URLSearchParams(init.body as URLSearchParams)
    expect(params.get("grant_type")).toBe("authorization_code")
    expect(params.get("code")).toBe("AUTHCODE")
    expect(params.get("redirect_uri")).toBe(flowState.redirectUri)
    expect(params.get("client_id")).toBe(CLAUDE_OAUTH_CLIENT_ID)
    expect(params.get("code_verifier")).toBe("fixed-verifier")

    expect(credential.accessToken).toBe("oat01-aaa")
    expect(credential.refreshToken).toBe("rt-bbb")
    expect(credential.expiresAtMs - Date.now()).toBeGreaterThan(3500 * 1000)
    expect(credential.email).toBe("u@example.com")
    expect(credential.plan).toBe("pro")
    expect(credential.mode).toBe("subscription")
  })

  it("throws on empty code", async () => {
    await expect(exchangeCodeForTokens({ code: "", flowState })).rejects.toThrow(
      /code must not be empty/
    )
  })

  it("throws when the server responds non-2xx", async () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "invalid_grant",
    }) as unknown as typeof fetch
    await expect(exchangeCodeForTokens({ code: "X", flowState })).rejects.toThrow(
      /400.*invalid_grant/
    )
  })

  it("throws when access_token is absent in a 200 response", async () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ refresh_token: "rt-only" }),
    }) as unknown as typeof fetch
    await expect(exchangeCodeForTokens({ code: "X", flowState })).rejects.toThrow(/no access_token/)
  })

  it("falls back to a default expires_in when the server omits it", async () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "b" }),
    }) as unknown as typeof fetch
    const credential = await exchangeCodeForTokens({ code: "X", flowState })
    // Default fallback is 8h ≈ 28800s.
    expect(credential.expiresAtMs - Date.now()).toBeGreaterThan(7 * 3600 * 1000)
  })
})

describe("refreshAccessToken", () => {
  it("posts grant_type=refresh_token and accepts a rotated refresh_token", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "oat01-new",
        refresh_token: "rt-rotated",
        expires_in: 7200,
      }),
    })
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch

    const credential = await refreshAccessToken({
      refreshToken: "rt-original",
      mode: "subscription",
    })
    const [, init] = fetchMock.mock.calls[0]
    const params = new URLSearchParams(init.body as URLSearchParams)
    expect(params.get("grant_type")).toBe("refresh_token")
    expect(params.get("refresh_token")).toBe("rt-original")
    expect(params.get("client_id")).toBe(CLAUDE_OAUTH_CLIENT_ID)

    expect(credential.accessToken).toBe("oat01-new")
    expect(credential.refreshToken).toBe("rt-rotated")
  })

  it("falls back to the original refresh_token when the server omits one", async () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "oat01-new", expires_in: 1 }),
    }) as unknown as typeof fetch

    const credential = await refreshAccessToken({
      refreshToken: "rt-original",
      mode: "subscription",
    })
    expect(credential.refreshToken).toBe("rt-original")
  })

  it("throws on an empty refresh_token", async () => {
    await expect(refreshAccessToken({ refreshToken: "", mode: "subscription" })).rejects.toThrow(
      /refreshToken must not be empty/
    )
  })
})

describe("isAnthropicCredentialFresh", () => {
  it("returns false when credential is null", () => {
    expect(isAnthropicCredentialFresh(null)).toBe(false)
  })

  it("returns false when the access token is empty", () => {
    expect(
      isAnthropicCredentialFresh({
        accessToken: "",
        refreshToken: "rt",
        expiresAtMs: Date.now() + 60 * 60_000,
        mode: "subscription",
        storedAtMs: 0,
      })
    ).toBe(false)
  })

  it("returns true when the expiry is well in the future", () => {
    expect(
      isAnthropicCredentialFresh({
        accessToken: "oat",
        refreshToken: "rt",
        expiresAtMs: Date.now() + 60 * 60_000,
        mode: "subscription",
        storedAtMs: 0,
      })
    ).toBe(true)
  })

  it("flips stale within the grace window", () => {
    expect(
      isAnthropicCredentialFresh({
        accessToken: "oat",
        refreshToken: "rt",
        expiresAtMs: Date.now() + 1_000, // 1s left — inside the 60s grace.
        mode: "subscription",
        storedAtMs: 0,
      })
    ).toBe(false)
  })
})
