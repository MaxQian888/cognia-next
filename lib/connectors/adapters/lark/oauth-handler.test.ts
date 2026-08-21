/**
 * Lark OAuth handler tests — OAuth 2.0 send-as-user flow.
 *
 * Mocks Dexie row reads, keyring get/set, the durable pending store, and the
 * two HTTP calls (v2 token exchange + user_info) so the test can drive the
 * full happy-path and the common failure paths without touching real networks.
 */

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
  updateAdapterInstance: jest.fn().mockResolvedValue(undefined),
}))

const mockHttp = jest.fn()
const mockKeyringGet = jest.fn()
const mockKeyringSet = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: (input: unknown) => mockHttp(input),
  connectorsKeyringGet: (adapterId: string, credential: string) =>
    mockKeyringGet(adapterId, credential),
  connectorsKeyringSet: (adapterId: string, credential: string, value: string) =>
    mockKeyringSet(adapterId, credential, value),
}))

const mockGetPending = jest.fn()
const mockClearPending = jest.fn()
jest.mock("./oauth-pending", () => ({
  getLarkOAuthPending: (adapterId: string) => mockGetPending(adapterId),
  clearLarkOAuthPending: (adapterId: string) => mockClearPending(adapterId),
}))

import { buildLarkOAuthState, parseLarkOAuthState, handleLarkOAuth } from "./oauth-handler"
import { clearUserTokenCache, getUserAccessToken } from "./auth"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"

const mockGetAdapter = getAdapterInstance as jest.Mock
const mockUpdateAdapter = updateAdapterInstance as jest.Mock

const REDIRECT = "https://relay.example/oauth/lark/callback"

const makeAdapterRow = () => ({
  id: "lk-1",
  type: "lark",
  displayName: "My Lark",
  enabled: true,
  transportMode: "long-connection",
  settings: { appId: "cli_test123" },
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["appSecret"] },
  trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
  defaultMode: "auto",
  createdAt: 1,
  updatedAt: 1,
})

/** Make `getLarkOAuthPending` return a pending record matching `state`. */
function primePending(state: string) {
  mockGetPending.mockReturnValue({
    state,
    codeVerifier: "verifier-1",
    redirectUri: REDIRECT,
    ts: Date.now(),
  })
}

/** v2 token-exchange HTTP response (flat OAuth 2.0 shape). */
function tokenV2Response() {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      code: 0,
      access_token: "u-access-789",
      refresh_token: "u-refresh-abc",
      expires_in: 7200,
      refresh_token_expires_in: 31_104_000,
      token_type: "Bearer",
      scope: "offline_access im:message",
    }),
  }
}

/** user_info HTTP response. */
function userInfoResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      code: 0,
      data: {
        open_id: "ou_alice",
        union_id: "on_alice",
        name: "Alice",
        avatar_url: "https://lark.example.com/alice.png",
        email: "alice@example.com",
        enterprise_email: "alice@bigcorp.example.com",
        ...overrides,
      },
    }),
  }
}

beforeEach(() => {
  mockHttp.mockReset()
  mockKeyringGet.mockReset()
  // appId + appSecret both resolve from the keyring by default.
  mockKeyringGet.mockImplementation(async (_id: string, cred: string) =>
    cred === "appId" ? "cli_test123" : cred === "appSecret" ? "secret_456" : null
  )
  mockKeyringSet.mockReset().mockResolvedValue(undefined)
  mockGetAdapter.mockReset()
  mockUpdateAdapter.mockReset().mockResolvedValue(undefined)
  mockGetPending.mockReset()
  mockClearPending.mockReset()
})

describe("buildLarkOAuthState / parseLarkOAuthState", () => {
  it("round-trips adapterId + nonce", () => {
    const state = buildLarkOAuthState("lk-1", "abc123")
    expect(state).toBe("lark:lk-1:abc123")
    expect(parseLarkOAuthState(state)).toEqual({ adapterId: "lk-1", nonce: "abc123" })
  })

  it("handles nonces that contain ':' by joining the tail", () => {
    const state = buildLarkOAuthState("lk-1", "abc:def")
    expect(parseLarkOAuthState(state)).toEqual({ adapterId: "lk-1", nonce: "abc:def" })
  })

  it("returns null for non-lark state", () => {
    expect(parseLarkOAuthState("slack:adp:nonce")).toBeNull()
  })

  it("returns null for missing parts", () => {
    expect(parseLarkOAuthState("lark:")).toBeNull()
    expect(parseLarkOAuthState("garbage")).toBeNull()
  })
})

describe("handleLarkOAuth — happy path", () => {
  it("exchanges code, resolves identity, persists tokens, stamps connectedUser", async () => {
    const state = buildLarkOAuthState("lk-1", "nonce-1")
    primePending(state)
    mockGetAdapter.mockResolvedValueOnce(makeAdapterRow())
    mockKeyringGet.mockResolvedValueOnce("secret_456")
    // 1st HTTP: v2 token exchange. 2nd HTTP: user_info.
    mockHttp.mockResolvedValueOnce(tokenV2Response()).mockResolvedValueOnce(userInfoResponse())

    const before = Date.now()
    const result = await handleLarkOAuth("oauth-code-1", { state })
    const after = Date.now()

    expect(result.openId).toBe("ou_alice")
    expect(result.name).toBe("Alice")
    expect(result.email).toBe("alice@example.com")
    expect(result.expiresAtMs).toBeGreaterThanOrEqual(before + 7200 * 1000)
    expect(result.expiresAtMs).toBeLessThanOrEqual(after + 7200 * 1000)

    // Tokens persisted in keyring.
    expect(mockKeyringSet).toHaveBeenCalledWith("lk-1", "user_token", "u-access-789")
    expect(mockKeyringSet).toHaveBeenCalledWith("lk-1", "user_refresh_token", "u-refresh-abc")

    // Adapter row stamped with connectedUser and the credentials ref
    // gained the two new account names.
    expect(mockUpdateAdapter).toHaveBeenCalledTimes(1)
    const patch = mockUpdateAdapter.mock.calls[0][1]
    expect(patch.settings.connectedUser.openId).toBe("ou_alice")
    // Granted scopes normalized (split, deduped, sorted) and stamped.
    expect(patch.settings.connectedScopes.scopes).toEqual(["im:message", "offline_access"])
    expect(patch.credentialsRef.accounts).toEqual(
      expect.arrayContaining(["appSecret", "user_token", "user_refresh_token"])
    )

    // Pending authorization is cleared on success.
    expect(mockClearPending).toHaveBeenCalledWith("lk-1")
  })

  it("v2 token endpoint gets client creds + PKCE verifier + the pending redirect_uri", async () => {
    const state = buildLarkOAuthState("lk-1", "nonce")
    primePending(state)
    mockGetAdapter.mockResolvedValueOnce(makeAdapterRow())
    mockHttp.mockResolvedValueOnce(tokenV2Response()).mockResolvedValueOnce(userInfoResponse())

    await handleLarkOAuth("the-code", { state })

    const tokenCall = mockHttp.mock.calls[0][0]
    expect(tokenCall.url).toBe("https://open.feishu.cn/open-apis/authen/v2/oauth/token")
    expect(tokenCall.headers.Authorization).toBeUndefined()
    expect(JSON.parse(tokenCall.body)).toEqual({
      grant_type: "authorization_code",
      client_id: "cli_test123",
      client_secret: "secret_456",
      code: "the-code",
      redirect_uri: REDIRECT,
      code_verifier: "verifier-1",
    })

    // user_info is called with the freshly-minted user token.
    const infoCall = mockHttp.mock.calls[1][0]
    expect(infoCall.url).toBe("https://open.feishu.cn/open-apis/authen/v1/user_info")
    expect(infoCall.headers.Authorization).toBe("Bearer u-access-789")
  })
})

describe("handleLarkOAuth — error paths", () => {
  it("throws on malformed state", async () => {
    await expect(handleLarkOAuth("code", { state: "garbage" })).rejects.toThrow(/state malformed/i)
  })

  it("throws when adapter row is missing", async () => {
    mockGetAdapter.mockResolvedValueOnce(undefined)
    await expect(
      handleLarkOAuth("code", { state: buildLarkOAuthState("lk-missing", "x") })
    ).rejects.toThrow(/adapter lk-missing not found/i)
  })

  it("throws when adapter type is not lark", async () => {
    mockGetAdapter.mockResolvedValueOnce({ ...makeAdapterRow(), type: "slack" })
    await expect(
      handleLarkOAuth("code", { state: buildLarkOAuthState("lk-1", "x") })
    ).rejects.toThrow(/not a Lark adapter/)
  })

  it("throws when appId is missing from the keyring", async () => {
    mockGetAdapter.mockResolvedValueOnce(makeAdapterRow())
    mockKeyringGet.mockImplementation(async (_id: string, cred: string) =>
      cred === "appSecret" ? "secret_456" : null
    )
    await expect(
      handleLarkOAuth("code", { state: buildLarkOAuthState("lk-1", "x") })
    ).rejects.toThrow(/appId not found in keyring/i)
  })

  it("throws when app secret is not in keyring", async () => {
    mockGetAdapter.mockResolvedValueOnce(makeAdapterRow())
    mockKeyringGet.mockImplementation(async (_id: string, cred: string) =>
      cred === "appId" ? "cli_test123" : null
    )
    await expect(
      handleLarkOAuth("code", { state: buildLarkOAuthState("lk-1", "x") })
    ).rejects.toThrow(/app secret not found in keyring/i)
  })

  it("throws when there is no matching pending authorization", async () => {
    // getLarkOAuthPending returns undefined (default) — session expired.
    mockGetAdapter.mockResolvedValueOnce(makeAdapterRow())
    await expect(
      handleLarkOAuth("code", { state: buildLarkOAuthState("lk-1", "x") })
    ).rejects.toThrow(/no matching pending authorization/i)
  })

  it("throws when the pending state does not match the redirect state", async () => {
    primePending(buildLarkOAuthState("lk-1", "authorized-nonce"))
    mockGetAdapter.mockResolvedValueOnce(makeAdapterRow())
    await expect(
      handleLarkOAuth("code", { state: buildLarkOAuthState("lk-1", "tampered-nonce") })
    ).rejects.toThrow(/no matching pending authorization/i)
  })

  it("propagates Lark's error from the v2 token endpoint", async () => {
    const state = buildLarkOAuthState("lk-1", "x")
    primePending(state)
    mockGetAdapter.mockResolvedValueOnce(makeAdapterRow())
    mockHttp.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({
        code: 20050,
        error: "invalid_grant",
        error_description: "auth code expired",
      }),
    })
    await expect(handleLarkOAuth("code", { state })).rejects.toThrow(/auth code expired/)
  })
})

describe("handleLarkOAuth — in-memory user-token cache", () => {
  // `auth.ts` caches a cold keyring read with no known expiry, and
  // `getUserAccessToken` serves such an entry for the whole process lifetime.
  // Re-authorizing therefore has to evict it, or every later send keeps using
  // the token from before the re-authorization.
  afterEach(() => clearUserTokenCache("lk-1"))

  it("evicts the previous token so a re-authorization takes effect immediately", async () => {
    mockKeyringGet.mockImplementation(async (_id: string, cred: string) =>
      cred === "appId"
        ? "cli_test123"
        : cred === "appSecret"
          ? "secret_456"
          : cred === "user_token"
            ? "u-access-OLD"
            : null
    )
    // Warm the cache the way a live send would.
    await expect(getUserAccessToken("lk-1")).resolves.toBe("u-access-OLD")

    const state = buildLarkOAuthState("lk-1", "nonce-1")
    primePending(state)
    mockGetAdapter.mockResolvedValue(makeAdapterRow())
    mockHttp.mockResolvedValueOnce(tokenV2Response()).mockResolvedValueOnce(userInfoResponse())

    await handleLarkOAuth("code-1", { state })

    // The keyring now holds what the exchange wrote.
    expect(mockKeyringSet).toHaveBeenCalledWith("lk-1", "user_token", "u-access-789")
    mockKeyringGet.mockImplementation(async (_id: string, cred: string) =>
      cred === "user_token" ? "u-access-789" : null
    )

    await expect(getUserAccessToken("lk-1")).resolves.toBe("u-access-789")
  })
})
