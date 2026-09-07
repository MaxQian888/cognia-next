import { __resetCodexProbeDedupeForTesting, probeCodexUsage } from "./usage-probe"

import type { LimitsMeter, ProviderLimits } from "@/types/subscription"

// The replay dedupe is module state, so cases sharing a `fetchedAt` fixture
// would otherwise see the second one skipped as a duplicate.
beforeEach(() => {
  __resetCodexProbeDedupeForTesting()
})

const meter: LimitsMeter = {
  id: "session",
  labelKey: "subscription.limits.meter.session",
  kind: "window",
  usedPct: 28,
  resetAt: 1_700_000,
  status: "ok",
}

function snapshot(over: Partial<ProviderLimits> = {}): ProviderLimits {
  return {
    provider: "codex",
    accountId: "acc-1",
    accountLabel: "ChatGPT",
    fetchedAt: 1_000,
    meters: [meter],
    ...over,
  }
}

describe("probeCodexUsage", () => {
  it("persists and returns a snapshot that carries meters", async () => {
    const persist = jest.fn(async () => undefined)
    const query = jest.fn(async () => snapshot())
    const result = await probeCodexUsage("acc-1", { query, persist })
    expect(query).toHaveBeenCalledWith("acc-1")
    expect(persist).toHaveBeenCalledTimes(1)
    expect(result?.meters).toHaveLength(1)
  })

  it("returns null and does not persist when the runner yields null", async () => {
    const persist = jest.fn(async () => undefined)
    const result = await probeCodexUsage("acc-1", { query: async () => null, persist })
    expect(result).toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })

  // The panel reads Dexie, not this return value — so refusing to persist the
  // error rendered a blank panel and a stale bearer's 401 stayed invisible.
  it("persists an error-only snapshot so the panel can show why", async () => {
    const persist = jest.fn(async () => undefined)
    const errored = snapshot({ meters: [], error: "403" })
    const result = await probeCodexUsage("acc-1", { query: async () => errored, persist })
    expect(result).toEqual(errored)
    expect(persist).toHaveBeenCalledWith(errored)
  })

  it("does not persist an empty, error-free snapshot", async () => {
    const persist = jest.fn(async () => undefined)
    const blank = snapshot({ meters: [] })
    const result = await probeCodexUsage("acc-1", { query: async () => blank, persist })
    expect(result).toEqual(blank)
    expect(persist).not.toHaveBeenCalled()
  })
})

describe("replay dedupe", () => {
  it("does not re-persist a snapshot the coalescer replayed", async () => {
    // A tick landing inside the throttle window gets the previous reading back.
    // Writing it again would append a duplicate row on every such tick.
    const persist = jest.fn(async () => undefined)
    const replayed = snapshot()
    const query = jest.fn(async () => replayed)

    await probeCodexUsage("acc-1", { query, persist })
    await probeCodexUsage("acc-1", { query, persist })

    expect(query).toHaveBeenCalledTimes(2)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it("persists again once the reading is genuinely new", async () => {
    const persist = jest.fn(async () => undefined)
    const query = jest
      .fn()
      .mockResolvedValueOnce(snapshot({ fetchedAt: 1_000 }))
      .mockResolvedValueOnce(snapshot({ fetchedAt: 2_000 }))

    await probeCodexUsage("acc-1", { query, persist })
    await probeCodexUsage("acc-1", { query, persist })

    expect(persist).toHaveBeenCalledTimes(2)
  })

  it("keeps accounts independent", async () => {
    const persist = jest.fn(async () => undefined)
    const query = jest.fn(async () => snapshot())

    await probeCodexUsage("acc-1", { query, persist })
    await probeCodexUsage("acc-2", { query, persist })

    expect(persist).toHaveBeenCalledTimes(2)
  })
})
