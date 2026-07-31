/**
 * @jest-environment jsdom
 */

import { startCodexUsageScheduler } from "./scheduler"
import { PROBE_CADENCE_FLOOR_MS } from "@/lib/subscription/anthropic/scheduler"

import type { CodexSubscriptionSettings } from "@/types/subscription"

type ProbeCfg = Pick<
  CodexSubscriptionSettings,
  "probeEnabled" | "visibleIntervalMs" | "idleIntervalMs"
>

const enabled: ProbeCfg = {
  probeEnabled: true,
  visibleIntervalMs: 5 * 60_000,
  idleIntervalMs: 30 * 60_000,
}

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
})

describe("startCodexUsageScheduler", () => {
  it("does nothing when probeEnabled is false", async () => {
    const probe = jest.fn(async () => null)
    const handle = startCodexUsageScheduler(() => ({ ...enabled, probeEnabled: false }), {
      getActiveAccountId: () => "acc-1",
      probe,
      isVisible: () => true,
    })
    await handle.triggerNow()
    expect(probe).not.toHaveBeenCalled()
    handle.stop()
  })

  it("skips when there is no active account", async () => {
    const probe = jest.fn(async () => null)
    const handle = startCodexUsageScheduler(() => enabled, {
      getActiveAccountId: () => null,
      probe,
      isVisible: () => true,
    })
    await handle.triggerNow()
    expect(probe).not.toHaveBeenCalled()
    handle.stop()
  })

  it("probes the active account when enabled", async () => {
    const probe = jest.fn(async () => null)
    const handle = startCodexUsageScheduler(() => enabled, {
      getActiveAccountId: async () => "acc-1",
      probe,
      isVisible: () => true,
    })
    await handle.triggerNow()
    expect(probe).toHaveBeenCalledWith("acc-1")
    handle.stop()
  })

  it("runs an initial tick on start (timer at 0)", async () => {
    const probe = jest.fn(async () => null)
    const handle = startCodexUsageScheduler(() => enabled, {
      getActiveAccountId: () => "acc-1",
      probe,
      isVisible: () => true,
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(probe).toHaveBeenCalledTimes(1)
    handle.stop()
  })

  it("stop() halts the loop and is idempotent", async () => {
    const probe = jest.fn(async () => null)
    const handle = startCodexUsageScheduler(() => enabled, {
      getActiveAccountId: () => "acc-1",
      probe,
      isVisible: () => true,
    })
    await jest.advanceTimersByTimeAsync(0)
    handle.stop()
    handle.stop()
    const callsAfterStop = probe.mock.calls.length
    await jest.advanceTimersByTimeAsync(60 * 60_000)
    expect(probe.mock.calls.length).toBe(callsAfterStop)
  })

  it("clamps a too-fast visible cadence to the 60s floor", async () => {
    const probe = jest.fn(async () => null)
    const handle = startCodexUsageScheduler(
      () => ({ probeEnabled: true, visibleIntervalMs: 1_000, idleIntervalMs: 1_000 }),
      { getActiveAccountId: () => "acc-1", probe, isVisible: () => true }
    )
    await jest.advanceTimersByTimeAsync(0) // initial tick
    expect(probe).toHaveBeenCalledTimes(1)
    // Below the floor: nothing fires before 60s elapses.
    await jest.advanceTimersByTimeAsync(PROBE_CADENCE_FLOOR_MS - 1)
    expect(probe).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(probe).toHaveBeenCalledTimes(2)
    handle.stop()
  })
})
