jest.mock("./config", () => ({
  ...jest.requireActual("./config"),
  getGoogleClientSecret: jest.fn(),
  getGoogleDocsSettings: jest.fn(),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsEnsureServer: jest.fn() }))
import { createGoogleDocsTestHost, GOOGLE_STATE_KEY } from "@/lib/testing/google-docs-host"
import { __setGoogleStatePortForTests } from "./state"
import type { GoogleConnectionState } from "./state"
import { CONNECTORS_SERVER_PORT } from "@/lib/connectors/server-transport"
import {
  getGoogleClientSecret,
  getGoogleDocsSettings,
  loadGoogleTokens,
  type GoogleOAuthTokens,
} from "./config"
import { getGoogleOAuthPending, type GoogleOAuthPending } from "./oauth-pending"
import type { GoogleHttpFn, GoogleHttpRequest } from "./http"
import {
  GOOGLE_AUTH_URL,
  GOOGLE_CALLBACK_PATH,
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
let host: ReturnType<typeof createGoogleDocsTestHost>
let values: Map<string, string>
const record = (): GoogleConnectionState => JSON.parse(values.get(GOOGLE_STATE_KEY)!)
function seedTokens(tokens: GoogleOAuthTokens | null) {
  values.set(GOOGLE_STATE_KEY, JSON.stringify({ ...record(), tokens }))
}
function seedPending(pending: GoogleOAuthPending | null) {
  values.set(GOOGLE_STATE_KEY, JSON.stringify({ ...record(), pending, claimed: false }))
}
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

beforeEach(async () => {
  jest.clearAllMocks()
  jest.spyOn(Date, "now").mockReturnValue(1000)
  values = new Map()
  host = createGoogleDocsTestHost({
    load: async (key) => values.get(key) ?? null,
    save: async (key, value) => {
      values.set(key, value)
    },
    delete: async (key) => {
      values.delete(key)
    },
  })
  __setGoogleStatePortForTests(host.call)
  settingsMock.mockResolvedValue({ clientId: "cid" })
  clientSecretMock.mockResolvedValue("csec")
  await beginGoogleDocsAuth({ ensureServer: async () => `127.0.0.1:${CONNECTORS_SERVER_PORT}` })
  jest.clearAllMocks()
})
afterEach(() => {
  __setGoogleStatePortForTests(null)
  jest.restoreAllMocks()
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
    expect(await getGoogleOAuthPending()).toMatchObject({
      state,
      redirectUri: REDIRECT,
      codeVerifier: expect.any(String),
      ts: 1000,
    })
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
    expect(await getGoogleOAuthPending()).toBeNull()
  })
})

describe("completeGoogleDocsAuth", () => {
  const PENDING = { state: "google:abc", codeVerifier: "ver", redirectUri: REDIRECT, ts: 0 }

  it("exchanges the code, replaying the verifier and redirect", async () => {
    seedPending(PENDING)
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
    expect(await loadGoogleTokens()).toEqual(tokens)
    expect(record().accountEmail).toBe("a@b.c")
    expect(await getGoogleOAuthPending()).toBeNull()
  })

  it("records the granted scopes and account email for the settings card", async () => {
    seedPending(PENDING)
    const { http } = httpWith([
      {
        body: JSON.stringify({ access_token: "at", refresh_token: "rt", scope: "drive.readonly" }),
      },
      { body: JSON.stringify({ email: "a@b.c" }) },
    ])
    await completeGoogleDocsAuth({ code: "abc", state: "google:abc" }, { http, now: () => 0 })
    expect(record()).toMatchObject({
      accountEmail: "a@b.c",
      tokens: { refreshToken: "rt", scope: "drive.readonly" },
    })
  })

  it("marks the connection unconnected when Google issued no refresh token", async () => {
    seedPending(PENDING)
    const { http } = httpWith([{ body: JSON.stringify({ access_token: "at" }) }, { body: "{}" }])
    await completeGoogleDocsAuth({ code: "abc", state: "google:abc" }, { http, now: () => 0 })
    expect(record().tokens?.refreshToken).toBeUndefined()
  })

  it.each([
    ["no pending record", null, { code: "c", state: "google:abc" }],
    ["a state mismatch", { ...PENDING }, { code: "c", state: "google:other" }],
    ["a missing state", { ...PENDING }, { code: "c" }],
    ["a missing code", { ...PENDING }, { state: "google:abc" }],
  ])("refuses on %s without consuming a different attempt", async (_label, pending, input) => {
    seedPending(pending)
    const { http } = httpWith([])
    await expect(completeGoogleDocsAuth(input, { http })).rejects.toMatchObject({
      code: "notAuthorized",
    })
    if (pending && "state" in input && input.state === pending.state)
      expect(await getGoogleOAuthPending()).toBeNull()
    else expect(await getGoogleOAuthPending()).toEqual(pending)
    expect(await loadGoogleTokens()).toBeNull()
  })

  it("surfaces a user denial with Google's own description", async () => {
    seedPending(PENDING)
    const { http } = httpWith([])
    await expect(
      completeGoogleDocsAuth(
        { state: PENDING.state, error: "access_denied", errorDescription: "user said no" },
        { http }
      )
    ).rejects.toMatchObject({ code: "notAuthorized", params: { reason: "user said no" } })
  })

  it("clears the pending record even when the token endpoint throws", async () => {
    seedPending(PENDING)
    const http: GoogleHttpFn = async () => {
      throw new Error("offline")
    }
    await expect(
      completeGoogleDocsAuth({ code: "c", state: "google:abc" }, { http })
    ).rejects.toThrow("offline")
    expect(await getGoogleOAuthPending()).toBeNull()
  })

  it("reports the token endpoint's error rather than a generic failure", async () => {
    seedPending(PENDING)
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
    seedTokens({ accessToken: "old", refreshToken: "rt", expiresAt: 0 })
    const { http, calls } = httpWith([
      { body: JSON.stringify({ access_token: "new", expires_in: 60 }) },
    ])
    const tokens = await refreshGoogleTokens({ http, now: () => 5000 })
    expect(calls[0].body).toContain("grant_type=refresh_token")
    expect(tokens).toMatchObject({ accessToken: "new", refreshToken: "rt", expiresAt: 65_000 })
  })

  it("reports a revoked grant as reconnect-required, not as a network blip", async () => {
    seedTokens({ accessToken: "old", refreshToken: "rt", expiresAt: 0 })
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
    seedTokens({ accessToken: "old", expiresAt: 0 })
    await expect(refreshGoogleTokens({ http: httpWith([]).http })).rejects.toMatchObject({
      code: "notAuthorized",
    })
  })
})

describe("getGoogleAccessToken", () => {
  it("reuses a token that is comfortably valid", async () => {
    seedTokens({ accessToken: "at", expiresAt: 10 * REFRESH_SKEW_MS })
    const { http, calls } = httpWith([])
    expect(await getGoogleAccessToken({ http, now: () => 0 })).toBe("at")
    expect(calls).toHaveLength(0)
  })

  it("refreshes inside the skew window", async () => {
    seedTokens({
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
    seedTokens(null)
    await expect(getGoogleAccessToken({ http: httpWith([]).http })).rejects.toMatchObject({
      code: "notConfigured",
    })
  })
})

describe("disconnectGoogleDocs", () => {
  it("clears local state and asks the host to revoke the refresh token", async () => {
    seedTokens({ accessToken: "at", refreshToken: "rt", expiresAt: 0 })
    host.revoke = jest.fn(async () => ({ revoked: true }))
    await expect(disconnectGoogleDocs()).resolves.toEqual({ revoked: true })
    expect(host.revoke).toHaveBeenCalledWith("rt")
    expect(await loadGoogleTokens()).toBeNull()
  })
  it("revokes the access token when no refresh token was ever issued", async () => {
    seedTokens({ accessToken: "at", expiresAt: 0 })
    host.revoke = jest.fn(async () => ({ revoked: true }))
    await expect(disconnectGoogleDocs()).resolves.toEqual({ revoked: true })
    expect(host.revoke).toHaveBeenCalledWith("at")
  })
  it("preserves the host's already-invalid-token success result", async () => {
    seedTokens({ accessToken: "at", refreshToken: "rt", expiresAt: 0 })
    host.revoke = async () => ({ revoked: true })
    await expect(disconnectGoogleDocs()).resolves.toEqual({ revoked: true })
    expect(await loadGoogleTokens()).toBeNull()
  })
  it("still clears local state when the host reports rejected revocation", async () => {
    seedTokens({ accessToken: "at", refreshToken: "rt", expiresAt: 0 })
    host.revoke = async () => ({ revoked: false, reason: "backend error" })
    await expect(disconnectGoogleDocs()).resolves.toEqual({
      revoked: false,
      reason: "backend error",
    })
    expect(await loadGoogleTokens()).toBeNull()
  })
  it("still clears local state when the request itself throws", async () => {
    seedTokens({ accessToken: "at", refreshToken: "rt", expiresAt: 0 })
    host.revoke = async () => {
      throw new Error("offline")
    }
    await expect(disconnectGoogleDocs()).resolves.toMatchObject({
      revoked: false,
      reason: expect.stringContaining("offline"),
    })
    expect(await loadGoogleTokens()).toBeNull()
  })
  it("skips revocation when nothing is stored", async () => {
    seedTokens(null)
    host.revoke = jest.fn()
    await expect(disconnectGoogleDocs()).resolves.toEqual({
      revoked: false,
      reason: "not-connected",
    })
    expect(host.revoke).not.toHaveBeenCalled()
    expect(await getGoogleOAuthPending()).toBeNull()
  })
})
