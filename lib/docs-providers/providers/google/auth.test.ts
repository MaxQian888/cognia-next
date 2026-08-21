jest.mock("./config", () => ({
  ...jest.requireActual("./config"),
  getGoogleClientSecret: jest.fn(),
  getGoogleDocsSettings: jest.fn(),
  loadGoogleTokens: jest.fn(),
  saveGoogleTokens: jest.fn(),
  updateGoogleDocsSettings: jest.fn(),
  clearGoogleConnection: jest.fn(),
}))
jest.mock("./oauth-pending", () => ({
  setGoogleOAuthPending: jest.fn(),
  getGoogleOAuthPending: jest.fn(),
  clearGoogleOAuthPending: jest.fn(),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsEnsureServer: jest.fn() }))

import { CONNECTORS_SERVER_PORT } from "@/lib/connectors/server-transport"
import {
  clearGoogleConnection,
  getGoogleClientSecret,
  getGoogleDocsSettings,
  loadGoogleTokens,
  saveGoogleTokens,
  updateGoogleDocsSettings,
} from "./config"
import {
  clearGoogleOAuthPending,
  getGoogleOAuthPending,
  setGoogleOAuthPending,
} from "./oauth-pending"
import type { GoogleHttpFn, GoogleHttpRequest } from "./http"
import {
  GOOGLE_AUTH_URL,
  GOOGLE_CALLBACK_PATH,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  REFRESH_SKEW_MS,
  beginGoogleDocsAuth,
  buildGoogleOAuthState,
  completeGoogleDocsAuth,
  disconnectGoogleDocs,
  getGoogleAccessToken,
  refreshGoogleTokens,
} from "./auth"

const clientSecretMock = getGoogleClientSecret as jest.Mock
const settingsMock = getGoogleDocsSettings as jest.Mock
const loadTokensMock = loadGoogleTokens as jest.Mock
const saveTokensMock = saveGoogleTokens as jest.Mock
const updateSettingsMock = updateGoogleDocsSettings as jest.Mock
const setPendingMock = setGoogleOAuthPending as jest.Mock
const getPendingMock = getGoogleOAuthPending as jest.Mock
const clearPendingMock = clearGoogleOAuthPending as jest.Mock
const clearConnectionMock = clearGoogleConnection as jest.Mock

const REDIRECT = `http://127.0.0.1:${CONNECTORS_SERVER_PORT}${GOOGLE_CALLBACK_PATH}`

function httpWith(responses: Array<{ status?: number; body: string }>) {
  const calls: GoogleHttpRequest[] = []
  const http: GoogleHttpFn = async (req) => {
    calls.push(req)
    const next = responses.shift()
    if (!next) throw new Error(`unexpected ${req.url}`)
    return { status: next.status ?? 200, headers: {}, body: next.body }
  }
  return { http, calls }
}

beforeEach(() => {
  jest.clearAllMocks()
  settingsMock.mockResolvedValue({ clientId: "cid" })
  clientSecretMock.mockResolvedValue("csec")
  updateSettingsMock.mockResolvedValue({})
  saveTokensMock.mockResolvedValue(undefined)
  clearConnectionMock.mockResolvedValue(undefined)
})

describe("buildGoogleOAuthState", () => {
  it("namespaces the state so the deep-link router can route it", () => {
    expect(buildGoogleOAuthState()).toMatch(/^google:[0-9a-f]{32}$/)
  })

  it("is unique per call", () => {
    expect(buildGoogleOAuthState()).not.toBe(buildGoogleOAuthState())
  })
})

describe("beginGoogleDocsAuth", () => {
  const ensureServer = jest.fn(async () => `127.0.0.1:${CONNECTORS_SERVER_PORT}`)

  it("requests the read scopes, offline access, PKCE, and the loopback redirect", async () => {
    const { authorizeUrl, redirectUri } = await beginGoogleDocsAuth({ ensureServer })
    expect(ensureServer).toHaveBeenCalledWith(CONNECTORS_SERVER_PORT)
    expect(redirectUri).toBe(REDIRECT)
    const url = new URL(authorizeUrl)
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_URL)
    const params = url.searchParams
    expect(params.get("client_id")).toBe("cid")
    expect(params.get("redirect_uri")).toBe(REDIRECT)
    expect(params.get("response_type")).toBe("code")
    expect(params.get("access_type")).toBe("offline")
    expect(params.get("prompt")).toBe("consent")
    expect(params.get("code_challenge_method")).toBe("S256")
    expect(params.get("code_challenge")).toBeTruthy()
    expect(params.get("scope")).toContain("drive.readonly")
    expect(params.get("scope")).toContain("spreadsheets.readonly")
  })

  it("persists the verifier, state and redirect for the completion step", async () => {
    const { authorizeUrl } = await beginGoogleDocsAuth({ ensureServer })
    const state = new URL(authorizeUrl).searchParams.get("state")
    expect(setPendingMock).toHaveBeenCalledWith(
      expect.objectContaining({ state, redirectUri: REDIRECT, codeVerifier: expect.any(String) }),
      expect.any(Number)
    )
  })

  it("uses the port the loopback listener actually bound", async () => {
    const { redirectUri } = await beginGoogleDocsAuth({
      ensureServer: async () => "127.0.0.1:51234",
    })
    expect(redirectUri).toBe(`http://127.0.0.1:51234${GOOGLE_CALLBACK_PATH}`)
  })

  it("refuses without a client id or secret instead of opening a broken consent page", async () => {
    settingsMock.mockResolvedValue({})
    await expect(beginGoogleDocsAuth({ ensureServer })).rejects.toMatchObject({
      code: "notConfigured",
      params: { field: "clientId" },
    })
    settingsMock.mockResolvedValue({ clientId: "cid" })
    clientSecretMock.mockResolvedValue(null)
    await expect(beginGoogleDocsAuth({ ensureServer })).rejects.toMatchObject({
      params: { field: "clientSecret" },
    })
  })

  it("reports hostUnsupported when the loopback listener cannot start", async () => {
    await expect(
      beginGoogleDocsAuth({
        ensureServer: async () => {
          throw new Error("no tauri")
        },
      })
    ).rejects.toMatchObject({ code: "hostUnsupported" })
    expect(setPendingMock).not.toHaveBeenCalled()
  })
})

describe("completeGoogleDocsAuth", () => {
  const PENDING = { state: "google:abc", codeVerifier: "ver", redirectUri: REDIRECT, ts: 0 }

  it("exchanges the code, replaying the verifier and redirect", async () => {
    getPendingMock.mockResolvedValue(PENDING)
    const { http, calls } = httpWith([
      {
        body: JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: "s",
        }),
      },
      { body: JSON.stringify({ email: "a@b.c" }) },
    ])
    const tokens = await completeGoogleDocsAuth(
      { code: "abc", state: "google:abc" },
      { http, now: () => 1000 }
    )
    expect(calls[0].url).toBe(GOOGLE_TOKEN_URL)
    expect(calls[0].body).toContain("code_verifier=ver")
    expect(calls[0].body).toContain(`redirect_uri=${encodeURIComponent(REDIRECT)}`)
    expect(calls[0].body).toContain("grant_type=authorization_code")
    expect(tokens).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1000 + 3600_000,
      scope: "s",
      tokenType: undefined,
    })
    expect(saveTokensMock).toHaveBeenCalledWith(tokens)
    expect(updateSettingsMock).toHaveBeenCalled()
    expect(clearPendingMock).toHaveBeenCalled()
  })

  it("records the granted scopes and account email for the settings card", async () => {
    getPendingMock.mockResolvedValue(PENDING)
    const { http } = httpWith([
      {
        body: JSON.stringify({ access_token: "at", refresh_token: "rt", scope: "drive.readonly" }),
      },
      { body: JSON.stringify({ email: "a@b.c" }) },
    ])
    await completeGoogleDocsAuth({ code: "abc", state: "google:abc" }, { http, now: () => 0 })
    const patch = updateSettingsMock.mock.calls[0][0] as (c: object) => Record<string, unknown>
    expect(patch({})).toMatchObject({
      connected: true,
      accountEmail: "a@b.c",
      grantedScopes: "drive.readonly",
    })
  })

  it("marks the connection unconnected when Google issued no refresh token", async () => {
    getPendingMock.mockResolvedValue(PENDING)
    const { http } = httpWith([{ body: JSON.stringify({ access_token: "at" }) }, { body: "{}" }])
    await completeGoogleDocsAuth({ code: "abc", state: "google:abc" }, { http, now: () => 0 })
    const patch = updateSettingsMock.mock.calls[0][0] as (c: object) => Record<string, unknown>
    expect(patch({})).toMatchObject({ connected: false })
  })

  it.each([
    ["no pending record", null, { code: "c", state: "google:abc" }],
    ["a state mismatch", { ...PENDING }, { code: "c", state: "google:other" }],
    ["a missing state", { ...PENDING }, { code: "c" }],
    ["a missing code", { ...PENDING }, { state: "google:abc" }],
  ])("refuses on %s and clears the pending record", async (_label, pending, input) => {
    getPendingMock.mockResolvedValue(pending)
    const { http } = httpWith([])
    await expect(completeGoogleDocsAuth(input, { http })).rejects.toMatchObject({
      code: "notAuthorized",
    })
    expect(clearPendingMock).toHaveBeenCalled()
    expect(saveTokensMock).not.toHaveBeenCalled()
  })

  it("surfaces a user denial with Google's own description", async () => {
    getPendingMock.mockResolvedValue(PENDING)
    const { http } = httpWith([])
    await expect(
      completeGoogleDocsAuth({ error: "access_denied", errorDescription: "user said no" }, { http })
    ).rejects.toMatchObject({ code: "notAuthorized", params: { reason: "user said no" } })
  })

  it("clears the pending record even when the token endpoint throws", async () => {
    getPendingMock.mockResolvedValue(PENDING)
    const http: GoogleHttpFn = async () => {
      throw new Error("offline")
    }
    await expect(
      completeGoogleDocsAuth({ code: "c", state: "google:abc" }, { http })
    ).rejects.toThrow("offline")
    expect(clearPendingMock).toHaveBeenCalled()
  })

  it("reports the token endpoint's error rather than a generic failure", async () => {
    getPendingMock.mockResolvedValue(PENDING)
    const { http } = httpWith([
      {
        status: 400,
        body: JSON.stringify({ error: "invalid_grant", error_description: "bad code" }),
      },
    ])
    await expect(
      completeGoogleDocsAuth({ code: "c", state: "google:abc" }, { http })
    ).rejects.toMatchObject({ code: "notAuthorized", params: { reason: "bad code" } })
  })
})

describe("refreshGoogleTokens", () => {
  it("carries the previous refresh token forward when Google omits it", async () => {
    loadTokensMock.mockResolvedValue({ accessToken: "old", refreshToken: "rt", expiresAt: 0 })
    const { http, calls } = httpWith([
      { body: JSON.stringify({ access_token: "new", expires_in: 60 }) },
    ])
    const tokens = await refreshGoogleTokens({ http, now: () => 5000 })
    expect(calls[0].body).toContain("grant_type=refresh_token")
    expect(tokens).toMatchObject({ accessToken: "new", refreshToken: "rt", expiresAt: 65_000 })
  })

  it("reports a revoked grant as reconnect-required, not as a network blip", async () => {
    loadTokensMock.mockResolvedValue({ accessToken: "old", refreshToken: "rt", expiresAt: 0 })
    const { http } = httpWith([
      {
        status: 400,
        body: JSON.stringify({ error: "invalid_grant", error_description: "revoked" }),
      },
    ])
    await expect(refreshGoogleTokens({ http })).rejects.toMatchObject({
      code: "notAuthorized",
      params: { reason: "revoked" },
    })
  })

  it("refuses when there is no refresh token to spend", async () => {
    loadTokensMock.mockResolvedValue({ accessToken: "old", expiresAt: 0 })
    await expect(refreshGoogleTokens({ http: httpWith([]).http })).rejects.toMatchObject({
      code: "notAuthorized",
    })
  })
})

describe("getGoogleAccessToken", () => {
  it("reuses a token that is comfortably valid", async () => {
    loadTokensMock.mockResolvedValue({ accessToken: "at", expiresAt: 10 * REFRESH_SKEW_MS })
    const { http, calls } = httpWith([])
    expect(await getGoogleAccessToken({ http, now: () => 0 })).toBe("at")
    expect(calls).toHaveLength(0)
  })

  it("refreshes inside the skew window", async () => {
    loadTokensMock.mockResolvedValue({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: REFRESH_SKEW_MS,
    })
    const { http } = httpWith([
      { body: JSON.stringify({ access_token: "fresh", expires_in: 3600 }) },
    ])
    expect(await getGoogleAccessToken({ http, now: () => 1 })).toBe("fresh")
  })

  it("reports notConfigured when the user never connected", async () => {
    loadTokensMock.mockResolvedValue(null)
    await expect(getGoogleAccessToken({ http: httpWith([]).http })).rejects.toMatchObject({
      code: "notConfigured",
    })
  })
})

describe("disconnectGoogleDocs", () => {
  it("revokes the refresh token at Google before clearing local state", async () => {
    loadTokensMock.mockResolvedValue({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 60_000,
    })
    const { http, calls } = httpWith([{ body: "" }])

    await expect(disconnectGoogleDocs({ http })).resolves.toEqual({ revoked: true })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(GOOGLE_REVOKE_URL)
    expect(calls[0].method).toBe("POST")
    // The refresh token is the one that carries the grant; revoking it takes
    // every access token minted from it with it.
    expect(calls[0].body).toBe("token=rt")
    expect(clearConnectionMock).toHaveBeenCalled()
  })

  it("revokes the access token when no refresh token was ever issued", async () => {
    loadTokensMock.mockResolvedValue({ accessToken: "at", expiresAt: Date.now() + 60_000 })
    const { calls, http } = httpWith([{ body: "" }])

    await expect(disconnectGoogleDocs({ http })).resolves.toEqual({ revoked: true })
    expect(calls[0].body).toBe("token=at")
  })

  it("treats an already-invalid token as revoked", async () => {
    loadTokensMock.mockResolvedValue({ accessToken: "at", refreshToken: "rt", expiresAt: 0 })
    const { http } = httpWith([{ status: 400, body: JSON.stringify({ error: "invalid_token" }) }])

    // The grant is gone either way — reporting a failure here would push the
    // user to go hunt for something that is not there.
    await expect(disconnectGoogleDocs({ http })).resolves.toEqual({ revoked: true })
    expect(clearConnectionMock).toHaveBeenCalled()
  })

  it("still clears local state when Google rejects the revocation", async () => {
    loadTokensMock.mockResolvedValue({ accessToken: "at", refreshToken: "rt", expiresAt: 0 })
    const { http } = httpWith([
      { status: 500, body: JSON.stringify({ error_description: "backend error" }) },
    ])

    await expect(disconnectGoogleDocs({ http })).resolves.toEqual({
      revoked: false,
      reason: "backend error",
    })
    // Refusing to disconnect locally would strand a user whose token Google
    // will not accept.
    expect(clearConnectionMock).toHaveBeenCalled()
  })

  it("still clears local state when the request itself throws", async () => {
    loadTokensMock.mockResolvedValue({ accessToken: "at", refreshToken: "rt", expiresAt: 0 })
    const http = jest.fn(async () => {
      throw new Error("offline")
    })

    await expect(disconnectGoogleDocs({ http })).resolves.toEqual({
      revoked: false,
      reason: "offline",
    })
    expect(clearConnectionMock).toHaveBeenCalled()
  })

  it("skips the network call when nothing is stored", async () => {
    loadTokensMock.mockResolvedValue(null)
    const { http, calls } = httpWith([])

    await expect(disconnectGoogleDocs({ http })).resolves.toEqual({
      revoked: false,
      reason: "not-connected",
    })
    expect(calls).toHaveLength(0)
    expect(clearConnectionMock).toHaveBeenCalled()
  })
})
