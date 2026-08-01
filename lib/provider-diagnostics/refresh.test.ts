/** @jest-environment jsdom */

import type { ProviderDiagnosticsRefreshState } from "@cognia/provider-types"

import {
  nextProviderDiagnosticsRefreshState,
  providerDiagnosticsNotificationTransition,
  runProviderDiagnosticsRefreshClock,
} from "./refresh"

const STATE: ProviderDiagnosticsRefreshState = {
  sourceId: "provider-balance:stepfun:primary",
  providerId: "stepfun",
  status: "running",
  nextDueAt: 0,
  consecutiveFailures: 0,
}

describe("provider diagnostics refresh clock", () => {
  it("honors Retry-After and exponential backoff capped at 24 hours", () => {
    expect(
      nextProviderDiagnosticsRefreshState(STATE, {
        kind: "failure",
        now: 1_000,
        intervalMs: 30 * 60_000,
        retryAfterMs: 7_200_000,
      }).nextDueAt
    ).toBe(7_201_000)

    const backedOff = nextProviderDiagnosticsRefreshState(
      { ...STATE, consecutiveFailures: 20 },
      { kind: "failure", now: 1_000, intervalMs: 30 * 60_000 }
    )
    expect(backedOff.nextDueAt).toBe(1_000 + 24 * 60 * 60_000)
  })

  it("pauses authentication failures until manual retry or credential change", () => {
    expect(
      nextProviderDiagnosticsRefreshState(STATE, {
        kind: "authentication",
        now: 1_000,
        intervalMs: 30 * 60_000,
      })
    ).toEqual(
      expect.objectContaining({ status: "paused-auth", nextDueAt: Number.MAX_SAFE_INTEGER })
    )
  })

  it("pauses all due sources offline and never invokes a paid benchmark", async () => {
    const states = [{ ...STATE, nextDueAt: 0 }]
    const putState = jest.fn(async () => undefined)
    const runFreeSource = jest.fn()

    const result = await runProviderDiagnosticsRefreshClock({
      now: () => 1_000,
      isOnline: () => false,
      isVaultAvailable: () => true,
      listDueStates: async () => states,
      putState,
      runFreeSource,
    })

    expect(result).toEqual({ scanned: 1, refreshed: 0, paused: 1 })
    expect(putState).toHaveBeenCalledWith(expect.objectContaining({ status: "paused-offline" }))
    expect(runFreeSource).not.toHaveBeenCalled()
  })

  it("uses a resumable vault pause instead of classifying a lock as bad authentication", async () => {
    const putState = jest.fn(async () => undefined)
    await runProviderDiagnosticsRefreshClock({
      now: () => 1_000,
      isOnline: () => true,
      isVaultAvailable: () => false,
      listDueStates: async () => [{ ...STATE, nextDueAt: 0 }],
      putState,
      runFreeSource: jest.fn(),
    })
    expect(putState).toHaveBeenCalledWith(expect.objectContaining({ status: "paused-vault" }))
  })

  it("refreshes due sources once and maps authentication outcomes", async () => {
    const putState = jest.fn(async () => undefined)
    const runFreeSource = jest.fn(async () => ({ code: "authentication" as const }))
    const result = await runProviderDiagnosticsRefreshClock({
      now: () => 1_000,
      isOnline: () => true,
      isVaultAvailable: () => true,
      listDueStates: async () => [{ ...STATE, nextDueAt: 0 }],
      putState,
      runFreeSource,
    })

    expect(result.refreshed).toBe(1)
    expect(putState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "paused-auth" }))
  })

  it("notifies only on authentication, repeat-failure, zero, and threshold transitions", () => {
    expect(
      providerDiagnosticsNotificationTransition({
        state: STATE,
        now: 1_000,
        failureCode: "authentication",
      })
    ).toBe("authentication")
    expect(
      providerDiagnosticsNotificationTransition({
        state: { ...STATE, lastObservedRemaining: 11 },
        now: 1_000,
        remaining: 9,
        threshold: 10,
      })
    ).toBe("low-balance")
    expect(
      providerDiagnosticsNotificationTransition({
        state: { ...STATE, lastObservedRemaining: 0, lastNotificationAt: 900 },
        now: 1_000,
        remaining: 0,
      })
    ).toBeUndefined()
  })

  it("persists notification cooldown state after a balance transition", async () => {
    const putState = jest.fn(async () => undefined)
    const notifyTransition = jest.fn(async () => undefined)
    await runProviderDiagnosticsRefreshClock({
      now: () => 1_000,
      isOnline: () => true,
      isVaultAvailable: () => true,
      listDueStates: async () => [{ ...STATE, lastObservedRemaining: 5 }],
      putState,
      runFreeSource: async () => ({ remaining: 0, balanceSourceId: "source-1" }),
      getThreshold: async () => undefined,
      notifyTransition,
    })

    expect(notifyTransition).toHaveBeenCalledWith(
      "zero-balance",
      expect.objectContaining({ lastNotificationAt: 1_000, lastObservedRemaining: 0 })
    )
  })
})
