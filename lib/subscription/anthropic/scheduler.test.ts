/**
 * @jest-environment jsdom
 */

const probeOnceMock = jest.fn()
jest.mock("./usage-probe", () => ({
  probeOnce: (...args: unknown[]) => probeOnceMock(...args),
}))

const isAnthropicCredentialFreshMock = jest.fn()
jest.mock("./oauth", () => ({
  isAnthropicCredentialFresh: (...args: unknown[]) => isAnthropicCredentialFreshMock(...args),
}))

import { clampCadence, PROBE_CADENCE_FLOOR_MS, startUsageScheduler } from "./scheduler"
import type { AnthropicCredentialData, UsageSnapshot } from "../core/types"

const credential: AnthropicCredentialData = {
  accessToken: "oat-1",
  refreshToken: "rt-1",
  expiresAtMs: 9999999999999,
  mode: "subscription",
  storedAtMs: 0,
}

const snapshot: UsageSnapshot = {
  fetchedAt: 1,
  source: "probe",
  status: "allowed",
  representativeClaim: "five_hour",
  fiveHour: { utilization: 0.1, resetAt: 0, status: "allowed" },
  sevenDay: null,
  fallbackPercentage: null,
  overageDisabledReason: null,
  rawHeaders: {},
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.resetAllMocks()
  isAnthropicCredentialFreshMock.mockReturnValue(true)
})

afterEach(() => {
  jest.useRealTimers()
})

describe("startUsageScheduler", () => {
  it("does nothing when probeEnabled is false", async () => {
    const persist = jest.fn()
    const handle = startUsageScheduler(
      () => ({ probeEnabled: false, visibleIntervalMs: 60_000, idleIntervalMs: 60_000 }),
      {
        getCredential: () => credential,
        refresh: async () => credential,
        isVisible: () => true,
        persist,
      }
    )
    await jest.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(probeOnceMock).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    handle.stop()
  })

  it("probes once on mount and persists the snapshot when ok", async () => {
    probeOnceMock.mockResolvedValue({ ok: true, snapshot })
    const persist = jest.fn().mockResolvedValue(null)
    const handle = startUsageScheduler(
      () => ({ probeEnabled: true, visibleIntervalMs: 60_000, idleIntervalMs: 60_000 }),
      {
        getCredential: () => credential,
        refresh: async () => credential,
        isVisible: () => true,
        persist,
      }
    )
    await jest.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(probeOnceMock).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith(snapshot)
    handle.stop()
  })

  it("retries once on auth failure after refresh", async () => {
    probeOnceMock
      .mockResolvedValueOnce({ ok: false, reason: "auth", status: 401 })
      .mockResolvedValueOnce({ ok: true, snapshot })
    const refreshed: AnthropicCredentialData = { ...credential, accessToken: "oat-2" }
    const refresh = jest.fn().mockResolvedValue(refreshed)
    const persist = jest.fn().mockResolvedValue(null)

    const handle = startUsageScheduler(
      () => ({ probeEnabled: true, visibleIntervalMs: 60_000, idleIntervalMs: 60_000 }),
      {
        getCredential: () => credential,
        refresh,
        isVisible: () => true,
        persist,
      }
    )
    await jest.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(probeOnceMock).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledWith(credential)
    expect(persist).toHaveBeenCalledWith(snapshot)
    handle.stop()
  })

  it("triggerNow forces an immediate probe outside the cadence", async () => {
    probeOnceMock.mockResolvedValue({ ok: true, snapshot })
    const persist = jest.fn().mockResolvedValue(null)
    const handle = startUsageScheduler(
      () => ({ probeEnabled: true, visibleIntervalMs: 1_000_000, idleIntervalMs: 1_000_000 }),
      {
        getCredential: () => credential,
        refresh: async () => credential,
        isVisible: () => true,
        persist,
      }
    )
    await jest.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(probeOnceMock).toHaveBeenCalledTimes(1)
    await handle.triggerNow()
    expect(probeOnceMock).toHaveBeenCalledTimes(2)
    handle.stop()
  })

  it("stop() cancels future ticks", async () => {
    probeOnceMock.mockResolvedValue({ ok: true, snapshot })
    const persist = jest.fn().mockResolvedValue(null)
    const handle = startUsageScheduler(
      () => ({ probeEnabled: true, visibleIntervalMs: 100, idleIntervalMs: 100 }),
      {
        getCredential: () => credential,
        refresh: async () => credential,
        isVisible: () => true,
        persist,
      }
    )
    await jest.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    handle.stop()
    await jest.advanceTimersByTimeAsync(1_000)
    expect(probeOnceMock).toHaveBeenCalledTimes(1)
  })

  it("skips when no credential is available", async () => {
    const persist = jest.fn()
    const handle = startUsageScheduler(
      () => ({ probeEnabled: true, visibleIntervalMs: 60_000, idleIntervalMs: 60_000 }),
      {
        getCredential: () => null,
        refresh: async () => null,
        isVisible: () => true,
        persist,
      }
    )
    await jest.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(probeOnceMock).not.toHaveBeenCalled()
    handle.stop()
  })
})

describe("clampCadence", () => {
  it("clamps below the floor", () => {
    expect(clampCadence(1000)).toBe(PROBE_CADENCE_FLOOR_MS)
    expect(clampCadence(0)).toBe(PROBE_CADENCE_FLOOR_MS)
    expect(clampCadence(-5)).toBe(PROBE_CADENCE_FLOOR_MS)
  })

  it("preserves values above the floor", () => {
    expect(clampCadence(5 * 60 * 1000)).toBe(5 * 60 * 1000)
  })

  it("returns the floor for non-finite values", () => {
    expect(clampCadence(Number.NaN)).toBe(PROBE_CADENCE_FLOOR_MS)
    expect(clampCadence(Number.POSITIVE_INFINITY)).toBe(PROBE_CADENCE_FLOOR_MS)
  })
})
