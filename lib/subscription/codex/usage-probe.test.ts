import { probeCodexUsage } from "./usage-probe"

import type { LimitsMeter, ProviderLimits } from "@/types/subscription"

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

  it("does not persist an error-only / empty snapshot", async () => {
    const persist = jest.fn(async () => undefined)
    const errored = snapshot({ meters: [], error: "403" })
    const result = await probeCodexUsage("acc-1", { query: async () => errored, persist })
    expect(result).toEqual(errored)
    expect(persist).not.toHaveBeenCalled()
  })
})
