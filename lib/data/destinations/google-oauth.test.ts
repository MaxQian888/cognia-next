/** @jest-environment jsdom */
import type { AppSettings } from "@cognia/agent-config-types"

const settingsState: { current: Partial<AppSettings> } = { current: {} }
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => settingsState.current,
  saveSettings: async (patch: Partial<AppSettings>) => {
    settingsState.current = { ...settingsState.current, ...patch }
    return settingsState.current
  },
}))

import {
  __setBackupDestinationSecretStoreForTesting,
  loadGoogleDriveTokens,
  saveGoogleDriveTokens,
  setGoogleDriveClientSecret,
} from "./config"
import {
  GOOGLE_DEVICE_CODE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  beginGoogleDeviceAuth,
  completeGoogleDeviceAuth,
  getGoogleDriveAccessToken,
  pollGoogleDeviceAuth,
  refreshGoogleDriveTokens,
} from "./google-oauth"
import type { BackupHttpFn, BackupHttpRequest } from "./http"

class MemoryStore {
  data = new Map<string, string>()
  async save(k: string, v: string) {
    this.data.set(k, v)
  }
  async load(k: string) {
    return this.data.get(k) ?? null
  }
  async delete(k: string) {
    this.data.delete(k)
  }
}

function scripted(responses: Array<(req: BackupHttpRequest) => { status: number; body: unknown }>) {
  const calls: BackupHttpRequest[] = []
  const http: BackupHttpFn = async (request) => {
    calls.push(request)
    const next = responses.shift()
    if (!next) throw new Error(`unexpected request ${request.method} ${request.url}`)
    const { status, body } = next(request)
    return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
  }
  return { http, calls }
}

beforeEach(async () => {
  __setBackupDestinationSecretStoreForTesting(new MemoryStore())
  settingsState.current = {
    backupDestinations: { googleDrive: { enabled: true, clientId: "cid" } },
  }
  await setGoogleDriveClientSecret("sec")
})
afterAll(() => __setBackupDestinationSecretStoreForTesting(null))

describe("device flow", () => {
  it("begins with a device code request for drive.file", async () => {
    const api = scripted([
      () => ({
        status: 200,
        body: {
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 1800,
          interval: 5,
        },
      }),
    ])
    const challenge = await beginGoogleDeviceAuth({ http: api.http, now: () => 1_000 })
    expect(challenge).toEqual({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://www.google.com/device",
      intervalSeconds: 5,
      expiresAt: 1_000 + 1800 * 1000,
    })
    expect(api.calls[0].url).toBe(GOOGLE_DEVICE_CODE_URL)
    expect(api.calls[0].body).toBe(
      "client_id=cid&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file"
    )
  })

  it("begin fails without a client id or on a Google error", async () => {
    settingsState.current = { backupDestinations: {} }
    await expect(beginGoogleDeviceAuth({ http: scripted([]).http })).rejects.toThrow(/client id/)
    settingsState.current = {
      backupDestinations: { googleDrive: { enabled: true, clientId: "cid" } },
    }
    const api = scripted([
      () => ({ status: 400, body: { error: "invalid_client", error_description: "bad" } }),
    ])
    await expect(beginGoogleDeviceAuth({ http: api.http })).rejects.toThrow("bad")
    const minimal = scripted([
      () => ({
        status: 200,
        body: { device_code: "dc", user_code: "u", verification_uri: "https://v" },
      }),
    ])
    const c = await beginGoogleDeviceAuth({ http: minimal.http, now: () => 0 })
    expect(c.verificationUrl).toBe("https://v")
    expect(c.intervalSeconds).toBe(5)
    expect(c.expiresAt).toBe(1800 * 1000)
  })

  it("maps every poll outcome and stores tokens + account email on success", async () => {
    const challenge = { deviceCode: "dc", expiresAt: 10_000 }
    const pending = scripted([() => ({ status: 428, body: { error: "authorization_pending" } })])
    expect(await pollGoogleDeviceAuth(challenge, { http: pending.http, now: () => 1 })).toEqual({
      status: "pending",
    })
    expect(pending.calls[0].url).toBe(GOOGLE_TOKEN_URL)
    expect(pending.calls[0].body).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
    )

    const slow = scripted([() => ({ status: 403, body: { error: "slow_down", interval: 12 } })])
    expect(await pollGoogleDeviceAuth(challenge, { http: slow.http, now: () => 1 })).toEqual({
      status: "slow_down",
      intervalSeconds: 12,
    })
    const denied = scripted([() => ({ status: 403, body: { error: "access_denied" } })])
    expect(await pollGoogleDeviceAuth(challenge, { http: denied.http, now: () => 1 })).toEqual({
      status: "denied",
    })
    const expired = scripted([() => ({ status: 400, body: { error: "expired_token" } })])
    expect(await pollGoogleDeviceAuth(challenge, { http: expired.http, now: () => 1 })).toEqual({
      status: "expired",
    })
    const other = scripted([
      () => ({ status: 400, body: { error: "invalid_grant", error_description: "nope" } }),
    ])
    expect(await pollGoogleDeviceAuth(challenge, { http: other.http, now: () => 1 })).toEqual({
      status: "error",
      error: "nope",
    })
    expect(
      await pollGoogleDeviceAuth(challenge, { http: scripted([]).http, now: () => 20_000 })
    ).toEqual({
      status: "expired",
    })

    const ok = scripted([
      () => ({
        status: 200,
        body: {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: "s",
          token_type: "Bearer",
        },
      }),
      (req) => {
        expect(req.url).toBe(GOOGLE_USERINFO_URL)
        return { status: 200, body: { email: "me@example.com" } }
      },
    ])
    const result = await pollGoogleDeviceAuth(challenge, { http: ok.http, now: () => 1_000 })
    expect(result).toEqual({
      status: "authorized",
      tokens: {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 1_000 + 3_600_000,
        scope: "s",
        tokenType: "Bearer",
      },
    })
    expect(await loadGoogleDriveTokens()).toMatchObject({ accessToken: "at", refreshToken: "rt" })
    expect(settingsState.current.backupDestinations?.googleDrive).toMatchObject({
      connected: true,
      accountEmail: "me@example.com",
    })
  })

  it("poll reports configuration problems", async () => {
    settingsState.current = { backupDestinations: {} }
    expect(
      await pollGoogleDeviceAuth(
        { deviceCode: "dc", expiresAt: 10 },
        { http: scripted([]).http, now: () => 1 }
      )
    ).toEqual({
      status: "error",
      error: "Google Drive backup is not configured.",
    })
    settingsState.current = {
      backupDestinations: { googleDrive: { enabled: true, clientId: "cid" } },
    }
    __setBackupDestinationSecretStoreForTesting(new MemoryStore())
    expect(
      await pollGoogleDeviceAuth(
        { deviceCode: "dc", expiresAt: 10 },
        { http: scripted([]).http, now: () => 1 }
      )
    ).toEqual({
      status: "error",
      error: "Google OAuth client secret is missing.",
    })
    await setGoogleDriveClientSecret("sec")
    const junk = scripted([() => ({ status: 500, body: "" })])
    expect(
      await pollGoogleDeviceAuth(
        { deviceCode: "dc", expiresAt: 10 },
        { http: junk.http, now: () => 1 }
      )
    ).toEqual({
      status: "error",
      error: "Google returned HTTP 500",
    })
  })

  it("completeGoogleDeviceAuth loops through pending/slow_down to a terminal state", async () => {
    const api = scripted([
      () => ({ status: 428, body: { error: "authorization_pending" } }),
      () => ({ status: 403, body: { error: "slow_down", interval: 7 } }),
      () => ({ status: 200, body: { access_token: "at", refresh_token: "rt", expires_in: 10 } }),
      () => ({ status: 200, body: { email: "e" } }),
    ])
    const sleeps: number[] = []
    const result = await completeGoogleDeviceAuth(
      {
        deviceCode: "dc",
        userCode: "u",
        verificationUrl: "v",
        intervalSeconds: 5,
        expiresAt: 10_000,
      },
      { http: api.http, now: () => 1, sleep: async (ms) => void sleeps.push(ms) }
    )
    expect(result.status).toBe("authorized")
    expect(sleeps).toEqual([5_000, 7_000])
    const aborted = new AbortController()
    aborted.abort()
    expect(
      await completeGoogleDeviceAuth(
        {
          deviceCode: "dc",
          userCode: "u",
          verificationUrl: "v",
          intervalSeconds: 5,
          expiresAt: 10_000,
        },
        { http: scripted([]).http, signal: aborted.signal }
      )
    ).toEqual({ status: "denied" })
  })
})

describe("token refresh", () => {
  it("returns a fresh token, refreshes near expiry, and preserves the refresh token", async () => {
    await saveGoogleDriveTokens({ accessToken: "fresh", refreshToken: "rt", expiresAt: 10_000_000 })
    expect(await getGoogleDriveAccessToken({ http: scripted([]).http, now: () => 1 })).toBe("fresh")

    await saveGoogleDriveTokens({ accessToken: "stale", refreshToken: "rt", expiresAt: 1_000 })
    const api = scripted([
      () => ({ status: 200, body: { access_token: "renewed", expires_in: 3600 } }),
    ])
    expect(await getGoogleDriveAccessToken({ http: api.http, now: () => 990 })).toBe("renewed")
    expect(api.calls[0].body).toContain("grant_type=refresh_token")
    expect(api.calls[0].body).toContain("refresh_token=rt")
    expect(await loadGoogleDriveTokens()).toMatchObject({
      accessToken: "renewed",
      refreshToken: "rt",
    })
  })

  it("returns null when disconnected and throws on refresh failures", async () => {
    expect(await getGoogleDriveAccessToken({ http: scripted([]).http })).toBeNull()
    await saveGoogleDriveTokens({ accessToken: "stale", expiresAt: 1 })
    expect(await getGoogleDriveAccessToken({ http: scripted([]).http, now: () => 5 })).toBeNull()
    await expect(
      refreshGoogleDriveTokens({ accessToken: "stale", expiresAt: 1 }, { http: scripted([]).http })
    ).rejects.toThrow(/reconnect/)
    const bad = scripted([
      () => ({ status: 400, body: { error: "invalid_grant", error_description: "revoked" } }),
    ])
    await expect(
      refreshGoogleDriveTokens(
        { accessToken: "s", refreshToken: "rt", expiresAt: 1 },
        { http: bad.http }
      )
    ).rejects.toThrow("revoked")
    settingsState.current = { backupDestinations: {} }
    await expect(
      refreshGoogleDriveTokens(
        { accessToken: "s", refreshToken: "rt", expiresAt: 1 },
        { http: scripted([]).http }
      )
    ).rejects.toThrow(/not configured/)
  })
})
