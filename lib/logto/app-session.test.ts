import {
  getActiveLogtoSession,
  REFRESH_SKEW_MS,
  signInToLogto,
  signOutFromLogto,
  type LogtoAppSessionDeps,
} from "./app-session"
import type { LogtoSession } from "./client"

const NOW = 1_000_000

function session(over: Partial<LogtoSession> = {}): LogtoSession {
  return {
    issuer: "https://logto.test/oidc",
    clientId: "app_1",
    resource: "https://api.test",
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: NOW + 3_600_000,
    scopes: ["openid", "brain:rpc"],
    ...over,
  }
}

const drivers = { openUrl: jest.fn(), waitForCode: jest.fn() }
const config = {
  issuer: "https://logto.test/oidc",
  clientId: "app_1",
  redirectUri: "https://cb",
  resource: "https://api.test",
}

describe("signInToLogto", () => {
  it("runs the flow and persists the resulting session", async () => {
    const s = session()
    const login = jest.fn(async () => s)
    const save = jest.fn(async () => {})
    const result = await signInToLogto(config, drivers, { login, save })
    expect(login).toHaveBeenCalledWith(config, drivers)
    expect(save).toHaveBeenCalledWith(s)
    expect(result).toBe(s)
  })
})

describe("getActiveLogtoSession", () => {
  const base = (over: Partial<LogtoAppSessionDeps>): LogtoAppSessionDeps => ({
    now: () => NOW,
    ...over,
  })

  it("returns null when nothing is stored", async () => {
    expect(await getActiveLogtoSession(base({ load: jest.fn(async () => null) }))).toBeNull()
  })

  it("returns a fresh session without refreshing", async () => {
    const s = session({ expiresAt: NOW + 3_600_000 })
    const refresh = jest.fn()
    const result = await getActiveLogtoSession(base({ load: jest.fn(async () => s), refresh }))
    expect(result).toBe(s)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("does not refresh a stale session that has no refresh token", async () => {
    const s = session({ expiresAt: NOW - 1, refreshToken: undefined })
    const refresh = jest.fn()
    const result = await getActiveLogtoSession(base({ load: jest.fn(async () => s), refresh }))
    expect(result).toBe(s)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("refreshes and persists when the token is within the skew window", async () => {
    const s = session({ expiresAt: NOW + REFRESH_SKEW_MS - 1 })
    const refreshed = session({ accessToken: "at2", expiresAt: NOW + 3_600_000 })
    const refresh = jest.fn<
      Promise<LogtoSession>,
      Parameters<NonNullable<LogtoAppSessionDeps["refresh"]>>
    >(async () => refreshed)
    const save = jest.fn(async () => {})
    const result = await getActiveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, save })
    )
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0]![1]).toBe("rt")
    expect(save).toHaveBeenCalledWith(refreshed)
    expect(result).toBe(refreshed)
  })

  it("surfaces the stale session when the refresh fails", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new Error("revoked")
    })
    const save = jest.fn(async () => {})
    const result = await getActiveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, save })
    )
    expect(result).toBe(s)
    expect(save).not.toHaveBeenCalled()
  })

  it("threads the organization id into the refresh config", async () => {
    const s = session({ expiresAt: NOW - 1, organizationId: "org_9" })
    const refresh = jest.fn<
      Promise<LogtoSession>,
      Parameters<NonNullable<LogtoAppSessionDeps["refresh"]>>
    >(async () => session())
    await getActiveLogtoSession(base({ load: jest.fn(async () => s), refresh, save: jest.fn() }))
    expect(refresh.mock.calls[0]![0]).toMatchObject({ organizationId: "org_9" })
  })
})

describe("signOutFromLogto", () => {
  it("clears the stored session", async () => {
    const clear = jest.fn(async () => {})
    await signOutFromLogto({ clear })
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
