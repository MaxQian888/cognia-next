const queryAccountLimitsMock = jest.fn()
jest.mock("./runner", () => ({
  queryAccountLimits: (...a: unknown[]) => queryAccountLimitsMock(...a),
}))

import { BACKOFF_POLICIES } from "@/lib/subscription/retry/backoff"
import {
  SubscriptionBreaker,
  __resetSubscriptionBreakerForTesting,
} from "@/lib/subscription/retry/breaker"

import {
  LIMITS_QUERY_FORCE_MIN_INTERVAL_MS,
  LIMITS_QUERY_MIN_INTERVAL_MS,
  queryAccountLimitsCoalesced,
  __resetLimitsCoalescerForTesting,
} from "./coalesce"

import type { ProviderId, ProviderLimits } from "@/types/subscription"

/** Failover is exercised in `quota-failover.test.ts`; keep it inert here. */
const noFailover = async () => null
/** Deterministic jitter so an asserted block length is exact. */
const noJitter = () => 0

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

let breaker: SubscriptionBreaker

beforeEach(() => {
  __resetLimitsCoalescerForTesting()
  __resetSubscriptionBreakerForTesting()
  queryAccountLimitsMock.mockReset()
  breaker = new SubscriptionBreaker()
})

/** Every call in this suite shares one ledger and skips the failover hook. */
const opts = <T extends Record<string, unknown>>(extra: T) => ({
  breaker,
  random: noJitter,
  failover: noFailover,
  ...extra,
})

describe("queryAccountLimitsCoalesced", () => {
  it("coalesces concurrent callers into a single query", async () => {
    const d = deferred<ProviderLimits | null>()
    const run = jest.fn(() => d.promise)

    const a = queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now: () => 1000 }))
    const b = queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now: () => 1000 }))

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

    const first = await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    expect(first).toEqual(limits("acc-1", 1))

    // 30s later — still inside the 60s floor: no new query, replays result 1.
    clock += 30_000
    const second = await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(second).toEqual(limits("acc-1", 1))

    // Past the floor — a real query runs again.
    clock += LIMITS_QUERY_MIN_INTERVAL_MS
    const third = await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    expect(run).toHaveBeenCalledTimes(2)
    expect(third).toEqual(limits("acc-1", 2))
  })

  it("force bypasses the normal throttle after the hard click cooldown", async () => {
    const run = jest
      .fn<Promise<ProviderLimits | null>, [ProviderId, string]>()
      .mockResolvedValueOnce(limits("acc-1", 1))
      .mockResolvedValueOnce(limits("acc-1", 2))
    let clock = 1000
    const now = () => clock

    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    clock += LIMITS_QUERY_FORCE_MIN_INTERVAL_MS
    const forced = await queryAccountLimitsCoalesced(
      "anthropic",
      "acc-1",
      opts({
        run,
        now,
        force: true,
      })
    )

    expect(run).toHaveBeenCalledTimes(2)
    expect(forced).toEqual(limits("acc-1", 2))
  })

  it("does not let force bypass the hard click cooldown", async () => {
    const run = jest.fn(async () => limits("acc-1", 1))
    let clock = 1000
    const now = () => clock

    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    clock += LIMITS_QUERY_FORCE_MIN_INTERVAL_MS - 1
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))

    expect(run).toHaveBeenCalledTimes(1)
  })

  it("backs off after a 429 and preserves the last successful meters", async () => {
    const successful = {
      ...limits("acc-1", 100),
      meters: [{ id: "session", kind: "window" as const, usedPct: 42, status: "ok" as const }],
    }
    const limited = { ...limits("acc-1", 200), error: "429 Too Many Requests", meters: [] }
    const run = jest.fn().mockResolvedValueOnce(successful).mockResolvedValueOnce(limited)
    let clock = 1000
    const now = () => clock

    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    clock += LIMITS_QUERY_FORCE_MIN_INTERVAL_MS
    const result = await queryAccountLimitsCoalesced(
      "anthropic",
      "acc-1",
      opts({
        run,
        now,
        force: true,
      })
    )

    expect(result).toMatchObject({
      fetchedAt: 200,
      error: "429 Too Many Requests",
      meters: successful.meters,
    })
    // A bare "429 Too Many Requests" carries no signal past the status, so it
    // is read as an account cap and blocked for the account-quota base.
    const block = BACKOFF_POLICIES["account-quota"].baseMs
    clock += block - 1
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(2)

    clock += 1
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("honors a server reset window longer than any interval of ours", async () => {
    // The old code armed a flat fifteen minutes for every 429. A provider
    // asking for two hours got probed eight times inside its own window.
    const limited = {
      ...limits("acc-1", 200),
      error: "429: Your limit will reset in 2 hours",
      meters: [],
    }
    const run = jest.fn().mockResolvedValue(limited)
    let clock = 1000
    const now = () => clock

    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    expect(run).toHaveBeenCalledTimes(1)

    clock += 2 * 60 * 60_000 - 1
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(1)

    clock += 1
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("blocks on a 403 account cap, which used to arm nothing at all", async () => {
    const capped = {
      ...limits("acc-1", 200),
      error: "403: Reached overall message rate limit",
      meters: [],
    }
    const run = jest.fn().mockResolvedValue(capped)
    let clock = 1000
    const now = () => clock

    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    clock += LIMITS_QUERY_MIN_INTERVAL_MS * 3
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("latches a revoked credential so it is never re-probed on its own", async () => {
    const revoked = { ...limits("acc-1", 200), error: '400: {"error":"invalid_grant"}', meters: [] }
    const run = jest.fn().mockResolvedValue(revoked)
    let clock = 1000
    const now = () => clock

    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    clock += 30 * 24 * 60 * 60_000
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("escalates the block while the failure persists", async () => {
    const limited = { ...limits("acc-1", 200), error: "429: 5 requests per minute", meters: [] }
    const run = jest.fn().mockResolvedValue(limited)
    let clock = 1000
    const now = () => clock
    const base = BACKOFF_POLICIES.throttled.baseMs

    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    clock += base
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(2)

    // The second failure doubles the wait, so the same gap is no longer enough.
    clock += base
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(2)

    clock += base
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("clears the block once a reading succeeds", async () => {
    const limited = { ...limits("acc-1", 1), error: "429: 5 requests per minute", meters: [] }
    const run = jest
      .fn()
      .mockResolvedValueOnce(limited)
      .mockResolvedValueOnce(limits("acc-1", 2))
      .mockResolvedValueOnce(limits("acc-1", 3))
    let clock = 1000
    const now = () => clock

    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    clock += BACKOFF_POLICIES.throttled.baseMs
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(2)

    // The success reset the counter, so the next attempt is gated only by the
    // ordinary click floor rather than by a doubled backoff.
    clock += LIMITS_QUERY_FORCE_MIN_INTERVAL_MS
    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("does not let an explicit refresh punch through a provider block", async () => {
    const limited = { ...limits("acc-1", 200), error: "429 Too Many Requests", meters: [] }
    const run = jest.fn().mockResolvedValue(limited)
    let clock = 1000
    const now = () => clock

    await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    // Ten impatient clicks, each past the click floor. The server said stop.
    for (let i = 0; i < 10; i++) {
      clock += LIMITS_QUERY_FORCE_MIN_INTERVAL_MS
      await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now, force: true }))
    }
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("force still coalesces into a live request instead of starting a second", async () => {
    const d = deferred<ProviderLimits | null>()
    const run = jest.fn(() => d.promise)

    const a = queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now: () => 1000 }))
    const b = queryAccountLimitsCoalesced(
      "anthropic",
      "acc-1",
      opts({
        run,
        now: () => 1000,
        force: true,
      })
    )

    expect(run).toHaveBeenCalledTimes(1)
    d.resolve(limits("acc-1", 9))
    await expect(a).resolves.toEqual(limits("acc-1", 9))
    await expect(b).resolves.toEqual(limits("acc-1", 9))
  })

  it("keys by (provider, accountId) — different targets don't share", async () => {
    const run = jest.fn(async (_p: ProviderId, accountId: string) => limits(accountId))
    const now = () => 1000

    await Promise.all([
      queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now })),
      queryAccountLimitsCoalesced("anthropic", "acc-2", opts({ run, now })),
      queryAccountLimitsCoalesced("codex", "acc-1", opts({ run, now })),
    ])

    expect(run).toHaveBeenCalledTimes(3)
  })

  it("backs off after a rejected query instead of hammering the endpoint", async () => {
    const run = jest
      .fn<Promise<ProviderLimits | null>, [ProviderId, string]>()
      .mockRejectedValueOnce(new Error("boom"))
    let clock = 1000
    const now = () => clock

    await expect(
      queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    ).rejects.toThrow("boom")

    // Still inside the floor: the failure stamped an attempt, so no retry — the
    // (null) last result replays without a second network hit.
    clock += 10_000
    const replayed = await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
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

    const first = await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))
    const second = await queryAccountLimitsCoalesced("anthropic", "acc-1", opts({ run, now }))

    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
  })
})
