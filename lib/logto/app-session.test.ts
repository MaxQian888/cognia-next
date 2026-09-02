const platformFetch = jest.fn()
jest.mock("@/lib/network/platform-fetch", () => ({
  createPlatformFetch: () => platformFetch,
}))

import {
  getActiveLogtoSession,
  readActiveAccessToken,
  resolveLogtoSession,
  REFRESH_SKEW_MS,
  signInToLogto,
  signOutFromLogto,
  signOutLeftTokensLive,
  type LogtoAppSessionDeps,
  type LogtoSignOutReport,
} from "./app-session"
import { LogtoRefreshError, type LogtoSession } from "./client"

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

/** Every keyring effect stubbed, with the marker stubs defaulting to "none". */
function base(over: Partial<LogtoAppSessionDeps>): LogtoAppSessionDeps {
  return {
    now: () => NOW,
    loadReauth: jest.fn(async () => null),
    markReauth: jest.fn(async () => {}),
    clearReauth: jest.fn(async () => {}),
    save: jest.fn(async () => {}),
    ...over,
  }
}

describe("signInToLogto", () => {
  it("runs the flow and persists the resulting session for the named profile", async () => {
    const s = session()
    const login = jest.fn(async () => s)
    const save = jest.fn(async () => {})
    const result = await signInToLogto(config, drivers, { login, save, localAccountId: "acct_a" })
    expect(login).toHaveBeenCalledWith(config, drivers)
    expect(save).toHaveBeenCalledWith(s, "acct_a")
    expect(result).toBe(s)
  })
})

describe("resolveLogtoSession", () => {
  it("is `none` when nothing is stored and no marker was left", async () => {
    const resolved = await resolveLogtoSession(base({ load: jest.fn(async () => null) }))
    expect(resolved).toEqual({ status: "none" })
  })

  it("surfaces a stored re-authentication marker when the session is gone", async () => {
    const metadata = {
      issuer: "https://logto.test/oidc",
      clientId: "app_1",
      resource: "r",
      scopes: [],
    }
    const resolved = await resolveLogtoSession(
      base({
        load: jest.fn(async () => null),
        loadReauth: jest.fn(async () => ({ reason: "revoked" as const, metadata, at: NOW })),
      })
    )
    expect(resolved).toEqual({ status: "reauth-required", reason: "revoked", metadata })
  })

  it("returns a fresh session as active without refreshing", async () => {
    const s = session({ expiresAt: NOW + 3_600_000 })
    const refresh = jest.fn()
    const resolved = await resolveLogtoSession(base({ load: jest.fn(async () => s), refresh }))
    expect(resolved).toEqual({ status: "active", session: s })
    expect(refresh).not.toHaveBeenCalled()
  })

  it("an expired session with no refresh token is dead, not active", async () => {
    // This is the case the old shape got wrong: a token past its expiry came
    // back as a session and every consumer presented it.
    const s = session({ expiresAt: NOW - 1, refreshToken: undefined })
    const markReauth = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), markReauth, localAccountId: "acct_a" })
    )
    expect(resolved.status).toBe("reauth-required")
    if (resolved.status !== "reauth-required") throw new Error("unreachable")
    expect(resolved.reason).toBe("expired")
    expect(resolved.metadata).toMatchObject({ issuer: s.issuer, clientId: "app_1" })
    expect(resolved.metadata).not.toHaveProperty("accessToken")
    expect(markReauth).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "expired", at: NOW }),
      "acct_a"
    )
  })

  it("refreshes and persists when the token is within the skew window", async () => {
    const s = session({ expiresAt: NOW + REFRESH_SKEW_MS - 1 })
    const refreshed = session({ accessToken: "at2", expiresAt: NOW + 3_600_000 })
    const refresh = jest.fn<
      Promise<LogtoSession>,
      Parameters<NonNullable<LogtoAppSessionDeps["refresh"]>>
    >(async () => refreshed)
    const save = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, save, localAccountId: "acct_a" })
    )
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0]![1]).toBe("rt")
    expect(save).toHaveBeenCalledWith(refreshed, "acct_a")
    expect(resolved).toEqual({ status: "active", session: refreshed })
  })

  it("an invalid_grant clears the tokens and leaves a marker naming the reason", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("invalid_grant", "refused", {
        status: 400,
        oauthError: "invalid_grant",
        oauthErrorDescription: "grant request is invalid",
      })
    })
    const save = jest.fn(async () => {})
    const markReauth = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, save, markReauth })
    )
    expect(resolved).toMatchObject({ status: "reauth-required", reason: "revoked" })
    expect(save).not.toHaveBeenCalled()
    expect(markReauth).toHaveBeenCalledTimes(1)
  })

  it("reads an expiry description as `expired` rather than `revoked`", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("invalid_grant", "refused", {
        oauthError: "invalid_grant",
        oauthErrorDescription: "refresh token is expired",
      })
    })
    const resolved = await resolveLogtoSession(base({ load: jest.fn(async () => s), refresh }))
    expect(resolved).toMatchObject({ status: "reauth-required", reason: "expired" })
  })

  it("a network failure keeps the material and reports offline", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("network", "fetch failed")
    })
    const markReauth = jest.fn(async () => {})
    const save = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, markReauth, save })
    )
    expect(resolved).toMatchObject({ status: "offline", metadata: { issuer: s.issuer } })
    // Nothing was written: the refresh token still works and must survive.
    expect(markReauth).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it("a 5xx from the issuer is offline too, not a revocation", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("server", "503", { status: 503 })
    })
    const resolved = await resolveLogtoSession(base({ load: jest.fn(async () => s), refresh }))
    expect(resolved.status).toBe("offline")
  })

  it("a rejected refresh (misconfiguration) is an error with the material kept", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("rejected", "invalid_client", { oauthError: "invalid_client" })
    })
    const markReauth = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, markReauth })
    )
    expect(resolved).toMatchObject({ status: "error", reason: "invalid_client" })
    expect(markReauth).not.toHaveBeenCalled()
  })

  it("an untyped throw is an error, never a revocation", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new Error("something else")
    })
    const markReauth = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, markReauth })
    )
    expect(resolved).toMatchObject({ status: "error", reason: "something else" })
    expect(markReauth).not.toHaveBeenCalled()
  })

  it("threads the organization id into the refresh config", async () => {
    const s = session({ expiresAt: NOW - 1, organizationId: "org_9" })
    const refresh = jest.fn<
      Promise<LogtoSession>,
      Parameters<NonNullable<LogtoAppSessionDeps["refresh"]>>
    >(async () => session())
    await resolveLogtoSession(base({ load: jest.fn(async () => s), refresh }))
    expect(refresh.mock.calls[0]![0]).toMatchObject({ organizationId: "org_9" })
  })
})

describe("getActiveLogtoSession / readActiveAccessToken", () => {
  it("hand out a token only for the active state", async () => {
    const s = session()
    expect(await getActiveLogtoSession(base({ load: jest.fn(async () => s) }))).toBe(s)
    expect(await readActiveAccessToken("acct_a", base({ load: jest.fn(async () => s) }))).toBe("at")
  })

  it("return null for every other state, including a stale session that could not refresh", async () => {
    const stale = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("network", "down")
    })
    expect(
      await getActiveLogtoSession(base({ load: jest.fn(async () => stale), refresh }))
    ).toBeNull()
    expect(
      await readActiveAccessToken("acct_a", base({ load: jest.fn(async () => stale), refresh }))
    ).toBeNull()
    expect(await getActiveLogtoSession(base({ load: jest.fn(async () => null) }))).toBeNull()
  })

  it("passes the profile through to the store", async () => {
    const load = jest.fn(async () => session())
    await readActiveAccessToken("acct_z", base({ load }))
    expect(load).toHaveBeenCalledWith("acct_z")
  })
})

describe("signOutFromLogto", () => {
  const discover = jest.fn(async () => ({
    issuer: "https://logto.test/oidc",
    authorizationEndpoint: "a",
    tokenEndpoint: "t",
    endSessionEndpoint: "https://logto.test/oidc/session/end",
  }))

  it("revokes the refresh and access tokens at the issuer, then clears both keyring entries", async () => {
    const s = session({ idToken: "idt" })
    const revoke = jest.fn(async () => ({ status: "revoked" as const }))
    const clear = jest.fn(async () => {})
    const clearReauth = jest.fn(async () => {})
    const report = await signOutFromLogto({
      load: jest.fn(async () => s),
      revoke,
      discover,
      clear,
      clearReauth,
      localAccountId: "acct_a",
    })
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(revoke.mock.calls[0]).toEqual([s, "rt", "refresh_token", platformFetch])
    expect(revoke.mock.calls[1]).toEqual([s, "at", "access_token", platformFetch])
    expect(clear).toHaveBeenCalledWith("acct_a")
    expect(clearReauth).toHaveBeenCalledWith("acct_a")
    expect(report).toMatchObject({
      hadSession: true,
      cleared: true,
      refreshTokenRevocation: { status: "revoked" },
      accessTokenRevocation: { status: "revoked" },
    })
    const url = new URL(report.endSessionUrl!)
    expect(url.origin + url.pathname).toBe("https://logto.test/oidc/session/end")
    expect(url.searchParams.get("id_token_hint")).toBe("idt")
    expect(url.searchParams.get("client_id")).toBe("app_1")
    expect(signOutLeftTokensLive(report)).toBe(false)
  })

  it("still clears locally when the issuer cannot be reached, and says so", async () => {
    const revoke = jest.fn(async () => ({ status: "failed" as const, reason: "ECONNREFUSED" }))
    const clear = jest.fn(async () => {})
    const report = await signOutFromLogto({
      load: jest.fn(async () => session()),
      revoke,
      discover: jest.fn(async () => {
        throw new Error("down")
      }),
      clear,
      clearReauth: jest.fn(async () => {}),
    })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(report.endSessionUrl).toBeNull()
    expect(signOutLeftTokensLive(report)).toBe(true)
  })

  it("clears a marker even when there was no session, and reports no revocation", async () => {
    const revoke = jest.fn()
    const clearReauth = jest.fn(async () => {})
    const report = await signOutFromLogto({
      load: jest.fn(async () => null),
      revoke,
      clear: jest.fn(async () => {}),
      clearReauth,
    })
    expect(revoke).not.toHaveBeenCalled()
    expect(clearReauth).toHaveBeenCalledTimes(1)
    expect(report).toMatchObject({
      hadSession: false,
      refreshTokenRevocation: null,
      accessTokenRevocation: null,
    })
    expect(signOutLeftTokensLive(report)).toBe(false)
  })

  it("revokes only the access token when there is no refresh token, and threads the redirect", async () => {
    const revoke = jest.fn(async () => ({ status: "revoked" as const }))
    const report = await signOutFromLogto(
      {
        load: jest.fn(async () => session({ refreshToken: undefined })),
        revoke,
        discover,
        clear: jest.fn(async () => {}),
        clearReauth: jest.fn(async () => {}),
      },
      { postLogoutRedirectUri: "https://app.test/bye" }
    )
    expect(revoke).toHaveBeenCalledTimes(1)
    expect((revoke.mock.calls[0] as unknown[])[2]).toBe("access_token")
    expect(report.refreshTokenRevocation).toBeNull()
    expect(new URL(report.endSessionUrl!).searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.test/bye"
    )
  })

  it("skips revocation when asked to", async () => {
    const revoke = jest.fn()
    const report: LogtoSignOutReport = await signOutFromLogto(
      {
        load: jest.fn(async () => session()),
        revoke,
        discover,
        clear: jest.fn(async () => {}),
        clearReauth: jest.fn(async () => {}),
      },
      { revoke: false }
    )
    expect(revoke).not.toHaveBeenCalled()
    expect(report.refreshTokenRevocation).toBeNull()
  })
})
