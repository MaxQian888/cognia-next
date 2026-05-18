/**
 * Lark OAuth handler tests — ADR-0009 v41 / A4 (D2).
 *
 * Mocks Dexie row reads, keyring get/set, and the two HTTP calls (TAT +
 * OIDC exchange) so the test can drive the full happy-path and the
 * common failure paths without touching real networks.
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

import { buildLarkOAuthState, parseLarkOAuthState, handleLarkOAuth } from "./oauth-handler"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { clearTokenCache } from "./auth"

const mockGetAdapter = getAdapterInstance as jest.Mock
const mockUpdateAdapter = updateAdapterInstance as jest.Mock

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

beforeEach(() => {
  mockHttp.mockReset()
  mockKeyringGet.mockReset()
  mockKeyringSet.mockReset().mockResolvedValue(undefined)
  mockGetAdapter.mockReset()
  mockUpdateAdapter.mockReset().mockResolvedValue(undefined)
  // Auth's TAT cache is module-scoped; clear so the test's HTTP mock fires.
  clearTokenCache("cli_test123", "secret_456")
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
  it("exchanges code, persists tokens, stamps connectedUser", async () => {
    mockGetAdapter.mockResolvedValueOnce(makeAdapterRow())
    mockKeyringGet.mockResolvedValueOnce("secret_456")
    // 1st HTTP call: TAT
    mockHttp.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 0, tenant_access_token: "t-tat-xyz", expire: 7200 }),
    })
    // 2nd HTTP call: OIDC access token
    mockHttp.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({
        code: 0,
        data: {
          access_token: "u-access-789",
          refresh_token: "u-refresh-abc",
          expires_in: 7200,
          refresh_expires_in: 31_104_000,
          token_type: "Bearer",
          scope: "im:message",
          open_id: "ou_alice",
          union_id: "on_alice",
          name: "Alice",
          avatar_url: "https://lark.example.com/alice.png",
          email: "alice@example.com",
          enterprise_email: "alice@bigcorp.example.com",
        },
      }),
    })

    const before = Date.now()
    const result = await handleLarkOAuth("oauth-code-1", {
      state: buildLarkOAuthState("lk-1", "nonce-1"),
    })
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
    expect(patch.credentialsRef.accounts).toEqual(
      expect.arrayContaining(["appSecret", "user_token", "user_refresh_token"])
    )
  })

  it("OIDC endpoint receives Bearer TAT and the authorization_code grant body", async () => {
    mockGetAdapter.mockResolvedValueOnce(makeAdapterRow())
    mockKeyringGet.mockResolvedValueOnce("secret_456")
    mockHttp
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ code: 0, tenant_access_token: "tat", expire: 7200 }),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          data: {
            access_token: "a",
            refresh_token: "r",
            open_id: "o",
          },
        }),
      })
    await handleLarkOAuth("the-code", {
      state: buildLarkOAuthState("lk-1", "nonce"),
    })

    const oidcCall = mockHttp.mock.calls[1][0]
    expect(oidcCall.url).toBe("https://open.feishu.cn/open-apis/authen/v1/oidc/access_token")
    expect(oidcCall.headers.Authorization).toBe("Bearer tat")
    const body = JSON.parse(oidcCall.body)
    expect(body).toEqual({ grant_type: "authorization_code", code: "the-code" })
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

  it("throws when appId is missing on the row", async () => {
    mockGetAdapter.mockResolvedValueOnce({
      ...makeAdapterRow(),
      settings: {},
    })
    await expect(
      handleLarkOAuth("code", { state: buildLarkOAuthState("lk-1", "x") })
    ).rejects.toThrow(/no appId configured/)
  })

  it("throws when app secret is not in keyring", async () => {
    mockGetAdapter.mockResolvedValueOnce(makeAdapterRow())
    mockKeyringGet.mockResolvedValueOnce(null)
    await expect(
      handleLarkOAuth("code", { state: buildLarkOAuthState("lk-1", "x") })
    ).rejects.toThrow(/app secret not found in keyring/i)
  })

  it("propagates Lark's non-zero error code from the OIDC endpoint", async () => {
    mockGetAdapter.mockResolvedValueOnce(makeAdapterRow())
    mockKeyringGet.mockResolvedValueOnce("secret")
    mockHttp
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ code: 0, tenant_access_token: "tat", expire: 7200 }),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ code: 99991661, msg: "auth code expired" }),
      })
    await expect(
      handleLarkOAuth("code", { state: buildLarkOAuthState("lk-1", "x") })
    ).rejects.toThrow(/auth code expired/)
  })
})
