/** @jest-environment jsdom */
import { SubscriptionBreaker } from "@/lib/subscription/retry/breaker"

import {
  providerRefreshKey,
  refreshExpiringOAuthCredentials,
  type RefreshSweepDeps,
} from "./oauth-credential-refresh"

import type { UserProviderSettings } from "@cognia/provider-types"

const NOW = 1_000_000
const noJitter = () => 0

function row(over: Partial<UserProviderSettings> = {}): UserProviderSettings {
  return {
    providerId: "acme",
    enabled: true,
    oauthConnected: true,
    oauthExpiresAt: NOW + 60_000,
    oauthRefreshToken: "rt-1",
    apiKey: "old-key",
    ...over,
  } as UserProviderSettings
}

function harness(
  settings: Record<string, UserProviderSettings>,
  refresh: RefreshSweepDeps["refresh"]
) {
  const written: Array<[string, Partial<UserProviderSettings>]> = []
  const breaker = new SubscriptionBreaker()
  const deps: RefreshSweepDeps = {
    readSettings: () => settings,
    writeSettings: (providerId, patch) => {
      written.push([providerId, patch])
    },
    now: () => NOW,
    breaker,
    random: noJitter,
    refresh,
  }
  return { deps, written, breaker }
}

describe("refreshExpiringOAuthCredentials", () => {
  it("renews a credential that is about to expire and writes it back", async () => {
    const h = harness(
      { acme: row() },
      jest.fn(async () => ({ apiKey: "new-key", refreshToken: "rt-2", expiresAt: NOW + 3_600_000 }))
    )
    const outcomes = await refreshExpiringOAuthCredentials(h.deps)
    expect(outcomes).toEqual([
      { providerId: "acme", status: "refreshed", expiresAt: NOW + 3_600_000 },
    ])
    expect(h.written).toEqual([
      ["acme", { apiKey: "new-key", oauthExpiresAt: NOW + 3_600_000, oauthRefreshToken: "rt-2" }],
    ])
  })

  it("leaves a credential alone until it is close to expiry", async () => {
    const refresh = jest.fn()
    const h = harness({ acme: row({ oauthExpiresAt: NOW + 60 * 60_000 }) }, refresh)
    const outcomes = await refreshExpiringOAuthCredentials(h.deps)
    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: "not-expiring" })
    expect(refresh).not.toHaveBeenCalled()
  })

  it("ignores a provider whose key did not come from an OAuth login", async () => {
    const refresh = jest.fn()
    const h = harness({ acme: row({ oauthConnected: false }) }, refresh)
    expect((await refreshExpiringOAuthCredentials(h.deps))[0]).toMatchObject({
      reason: "not-oauth",
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it("ignores a long-lived key with nothing to renew it with", async () => {
    // OpenRouter mints a key with no refresh token. There is nothing to spend.
    const refresh = jest.fn()
    const h = harness({ acme: row({ oauthRefreshToken: undefined }) }, refresh)
    expect((await refreshExpiringOAuthCredentials(h.deps))[0]).toMatchObject({
      reason: "no-refresh-token",
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it("stops re-asking a provider that refused the refresh", async () => {
    // A revoked grant does not heal. Re-POSTing it on every sweep is the exact
    // behaviour the credential ledger exists to prevent.
    const refresh = jest.fn(async () => {
      throw new Error('400: {"error":"invalid_grant"}')
    })
    const h = harness({ acme: row() }, refresh)

    expect((await refreshExpiringOAuthCredentials(h.deps))[0]).toMatchObject({ status: "failed" })
    expect(refresh).toHaveBeenCalledTimes(1)

    expect((await refreshExpiringOAuthCredentials(h.deps))[0]).toMatchObject({
      status: "skipped",
      reason: "blocked",
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(h.breaker.shouldAttempt(providerRefreshKey("acme"), NOW).permanent).toBe(true)
  })

  it("backs off a transient failure instead of retrying every sweep", async () => {
    const refresh = jest.fn(async () => {
      throw new Error("503: Service Unavailable")
    })
    const h = harness({ acme: row() }, refresh)
    await refreshExpiringOAuthCredentials(h.deps)
    await refreshExpiringOAuthCredentials(h.deps)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("stops sweeping a provider that declares no refresh spec", async () => {
    const refresh = jest.fn(async () => null)
    const h = harness({ acme: row() }, refresh)
    expect((await refreshExpiringOAuthCredentials(h.deps))[0]).toMatchObject({
      reason: "no-refresh-support",
    })
    expect((await refreshExpiringOAuthCredentials(h.deps))[0]).toMatchObject({ reason: "blocked" })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("keeps providers independent, so one failure does not stall the rest", async () => {
    const refresh = jest.fn(async (providerId: string) => {
      if (providerId === "bad") throw new Error("500: boom")
      return { apiKey: "k", expiresAt: NOW + 3_600_000 }
    })
    const h = harness({ bad: row(), good: row() }, refresh)
    const outcomes = await refreshExpiringOAuthCredentials(h.deps)
    expect(outcomes.find((o) => o.providerId === "bad")?.status).toBe("failed")
    expect(outcomes.find((o) => o.providerId === "good")?.status).toBe("refreshed")
  })

  it("carries the old refresh token forward when the provider does not rotate it", async () => {
    const h = harness(
      { acme: row() },
      jest.fn(async (_id: string, payload: { refreshToken: string }) => ({
        apiKey: "new-key",
        refreshToken: payload.refreshToken,
        expiresAt: NOW + 3_600_000,
      }))
    )
    await refreshExpiringOAuthCredentials(h.deps)
    expect(h.written[0]?.[1].oauthRefreshToken).toBe("rt-1")
  })

  it("does nothing when there are no provider settings at all", async () => {
    const h = harness({}, jest.fn())
    await expect(
      refreshExpiringOAuthCredentials({ ...h.deps, readSettings: () => undefined })
    ).resolves.toEqual([])
  })
})
