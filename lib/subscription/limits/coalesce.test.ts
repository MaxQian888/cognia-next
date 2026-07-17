const queryAccountLimitsMock = jest.fn()
jest.mock("./runner", () => ({
  queryAccountLimits: (...a: unknown[]) => queryAccountLimitsMock(...a),
}))

import {
  LIMITS_QUERY_MIN_INTERVAL_MS,
  queryAccountLimitsCoalesced,
  __resetLimitsCoalescerForTesting,
} from "./coalesce"

import type { ProviderId, ProviderLimits } from "@/types/subscription"

function limits(accountId: string, fetchedAt = 0): ProviderLimits {
  return { provider: "anthropic", accountId, fetchedAt, meters: [] }
}

/** A deferred promise so a test can hold a query "in flight". */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  __resetLimitsCoalescerForTesting()
  queryAccountLimitsMock.mockReset()
})

describe("queryAccountLimitsCoalesced", () => {
  it("coalesces concurrent callers into a single query", async () => {
    const d = deferred<ProviderLimits | null>()
    const run = jest.fn(() => d.promise)

    const a = queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now: () => 1000 })
    const b = queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now: () => 1000 })

    // Both callers share ONE underlying run.
    expect(run).toHaveBeenCalledTimes(1)
    d.resolve(limits("acc-1", 5))
    await expect(a).resolves.toEqual(limits("acc-1", 5))
    await expect(b).resolves.toEqual(limits("acc-1", 5))
  })

  it("throttles repeat queries within the interval, replaying the last result", async () => {
    const run = jest
      .fn<Promise<ProviderLimits | null>, [ProviderId, string]>()
      .mockResolvedValueOnce(limits("acc-1", 1))
      .mockResolvedValueOnce(limits("acc-1", 2))
    let clock = 1000
    const now = () => clock

    const first = await queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now })
    expect(first).toEqual(limits("acc-1", 1))

    // 30s later — still inside the 60s floor: no new query, replays result 1.
    clock += 30_000
    const second = await queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now })
    expect(run).toHaveBeenCalledTimes(1)
    expect(second).toEqual(limits("acc-1", 1))

    // Past the floor — a real query runs again.
    clock += LIMITS_QUERY_MIN_INTERVAL_MS
    const third = await queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now })
    expect(run).toHaveBeenCalledTimes(2)
    expect(third).toEqual(limits("acc-1", 2))
  })

  it("force bypasses the throttle", async () => {
    const run = jest
      .fn<Promise<ProviderLimits | null>, [ProviderId, string]>()
      .mockResolvedValueOnce(limits("acc-1", 1))
      .mockResolvedValueOnce(limits("acc-1", 2))
    const now = () => 1000

    await queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now })
    const forced = await queryAccountLimitsCoalesced("anthropic", "acc-1", {
      run,
      now,
      force: true,
    })

    expect(run).toHaveBeenCalledTimes(2)
    expect(forced).toEqual(limits("acc-1", 2))
  })

  it("force still coalesces into a live request instead of starting a second", async () => {
    const d = deferred<ProviderLimits | null>()
    const run = jest.fn(() => d.promise)

    const a = queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now: () => 1000 })
    const b = queryAccountLimitsCoalesced("anthropic", "acc-1", {
      run,
      now: () => 1000,
      force: true,
    })

    expect(run).toHaveBeenCalledTimes(1)
    d.resolve(limits("acc-1", 9))
    await expect(a).resolves.toEqual(limits("acc-1", 9))
    await expect(b).resolves.toEqual(limits("acc-1", 9))
  })

  it("keys by (provider, accountId) — different targets don't share", async () => {
    const run = jest.fn(async (_p: ProviderId, accountId: string) => limits(accountId))
    const now = () => 1000

    await Promise.all([
      queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now }),
      queryAccountLimitsCoalesced("anthropic", "acc-2", { run, now }),
      queryAccountLimitsCoalesced("codex", "acc-1", { run, now }),
    ])

    expect(run).toHaveBeenCalledTimes(3)
  })

  it("backs off after a rejected query instead of hammering the endpoint", async () => {
    const run = jest
      .fn<Promise<ProviderLimits | null>, [ProviderId, string]>()
      .mockRejectedValueOnce(new Error("boom"))
    let clock = 1000
    const now = () => clock

    await expect(queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now })).rejects.toThrow(
      "boom"
    )

    // Still inside the floor: the failure stamped an attempt, so no retry — the
    // (null) last result replays without a second network hit.
    clock += 10_000
    const replayed = await queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now })
    expect(run).toHaveBeenCalledTimes(1)
    expect(replayed).toBeNull()
  })

  it("defaults to the real clock + runner (queryAccountLimits) when not injected", async () => {
    queryAccountLimitsMock.mockResolvedValue(limits("acc-1", 7))
    const result = await queryAccountLimitsCoalesced("anthropic", "acc-1")
    expect(queryAccountLimitsMock).toHaveBeenCalledWith("anthropic", "acc-1")
    expect(result).toEqual(limits("acc-1", 7))
  })

  it("treats a null result as a real (throttleable) reading", async () => {
    const run = jest
      .fn<Promise<ProviderLimits | null>, [ProviderId, string]>()
      .mockResolvedValue(null)
    const now = () => 1000

    const first = await queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now })
    const second = await queryAccountLimitsCoalesced("anthropic", "acc-1", { run, now })

    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
  })
})
