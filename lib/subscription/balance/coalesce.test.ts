const queryAccountBalanceMock = jest.fn()
jest.mock("./runner", () => ({
  queryAccountBalance: (...a: unknown[]) => queryAccountBalanceMock(...a),
}))

import { BACKOFF_POLICIES } from "@/lib/subscription/retry/backoff"
import { SubscriptionBreaker } from "@/lib/subscription/retry/breaker"
import { limitsBreakerKey } from "@/lib/subscription/limits/coalesce-record"

import {
  BALANCE_QUERY_FORCE_MIN_INTERVAL_MS,
  BALANCE_QUERY_MIN_INTERVAL_MS,
  __resetBalanceCoalescerForTesting,
  queryAccountBalanceCoalesced,
} from "./coalesce"

import type { BalanceSnapshot, ProviderId } from "@/types/subscription"

function snap(over: Partial<BalanceSnapshot> = {}): BalanceSnapshot {
  return {
    fetchedAt: 1_000,
    providerKey: "deepseek",
    accountId: "acc-1",
    kind: "credit",
    remaining: 42,
    raw: {},
    ...over,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

let breaker: SubscriptionBreaker

beforeEach(() => {
  __resetBalanceCoalescerForTesting()
  queryAccountBalanceMock.mockReset()
  breaker = new SubscriptionBreaker()
})

const opts = <T extends Record<string, unknown>>(extra: T) => ({
  breaker,
  random: () => 0,
  ...extra,
})

describe("queryAccountBalanceCoalesced", () => {
  it("coalesces concurrent callers into a single query", async () => {
    const d = deferred<BalanceSnapshot | null>()
    const run = jest.fn(() => d.promise)

    const a = queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now: () => 1_000 }))
    const b = queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now: () => 1_000 }))

    expect(run).toHaveBeenCalledTimes(1)
    d.resolve(snap())
    await expect(a).resolves.toEqual(snap())
    await expect(b).resolves.toEqual(snap())
  })

  it("throttles repeat queries within the interval, replaying the last result", async () => {
    const run = jest
      .fn<Promise<BalanceSnapshot | null>, [ProviderId, string]>()
      .mockResolvedValueOnce(snap({ remaining: 1 }))
      .mockResolvedValueOnce(snap({ remaining: 2 }))
    let clock = 1_000
    const now = () => clock

    await queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now }))
    clock += 30_000
    const replayed = await queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(replayed).toMatchObject({ remaining: 1 })

    clock += BALANCE_QUERY_MIN_INTERVAL_MS
    await queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now }))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("force bypasses the normal throttle after the hard click cooldown", async () => {
    const run = jest.fn(async () => snap())
    let clock = 1_000
    const now = () => clock

    await queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now }))
    clock += BALANCE_QUERY_FORCE_MIN_INTERVAL_MS
    await queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("blocks after a failed reading instead of retrying on the next mount", async () => {
    const run = jest.fn(async () => snap({ error: "429: usage_limit_reached" }))
    let clock = 1_000
    const now = () => clock

    await queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now }))
    clock += BACKOFF_POLICIES["account-quota"].baseMs - 1
    await queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(1)

    clock += 1
    await queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("shares one block with the quota surfaces for the same credential", async () => {
    // Quota and balance are two reads against one credential. A block earned by
    // either has to stop both, or the pair simply takes turns being refused.
    breaker.recordFailure(
      limitsBreakerKey("anthropic", "acc-1"),
      { reason: "account-quota", retryable: true, rotatable: true, permanent: false },
      1_000,
      () => 0
    )
    const run = jest.fn(async () => snap())
    await queryAccountBalanceCoalesced(
      "anthropic",
      "acc-1",
      opts({ run, now: () => 1_000, force: true })
    )
    expect(run).not.toHaveBeenCalled()
  })

  it("propagates a rejected query after arming the block", async () => {
    const run = jest.fn(async () => {
      throw new Error("503: Service Unavailable")
    })
    const now = () => 1_000

    await expect(
      queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now }))
    ).rejects.toThrow("503")
    expect(breaker.shouldAttempt(limitsBreakerKey("anthropic", "acc-1"), 1_000).allowed).toBe(false)
  })

  it("keys by (provider, accountId)", async () => {
    const run = jest.fn(async () => snap())
    const now = () => 1_000
    await Promise.all([
      queryAccountBalanceCoalesced("anthropic", "acc-1", opts({ run, now })),
      queryAccountBalanceCoalesced("anthropic", "acc-2", opts({ run, now })),
      queryAccountBalanceCoalesced("codex", "acc-1", opts({ run, now })),
    ])
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("defaults to the real runner when none is injected", async () => {
    queryAccountBalanceMock.mockResolvedValue(snap())
    const result = await queryAccountBalanceCoalesced("anthropic", "acc-1", opts({}))
    expect(queryAccountBalanceMock).toHaveBeenCalledWith("anthropic", "acc-1")
    expect(result).toEqual(snap())
  })
})
