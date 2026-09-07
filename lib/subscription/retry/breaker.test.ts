import { BACKOFF_POLICIES } from "./backoff"
import {
  BREAKER_SCOPES,
  SubscriptionBreaker,
  __resetSubscriptionBreakerForTesting,
  credentialKey,
  getSubscriptionBreaker,
} from "./breaker"

import type { SubscriptionFailure } from "./failure-class"

const NOW = 1_000_000
const noJitter = () => 0

const failure = (over: Partial<SubscriptionFailure> = {}): SubscriptionFailure => ({
  reason: "throttled",
  retryable: true,
  rotatable: false,
  permanent: false,
  ...over,
})

describe("SubscriptionBreaker", () => {
  let breaker: SubscriptionBreaker
  const key = credentialKey("anthropic", "acct-1", BREAKER_SCOPES.usage)

  beforeEach(() => {
    breaker = new SubscriptionBreaker()
  })

  it("allows an unseen credential", () => {
    expect(breaker.shouldAttempt(key, NOW).allowed).toBe(true)
  })

  it("blocks for the reason's backoff after one failure", () => {
    const until = breaker.recordFailure(key, failure(), NOW, noJitter)
    expect(until).toBe(NOW + BACKOFF_POLICIES.throttled.baseMs)
    expect(breaker.shouldAttempt(key, NOW).allowed).toBe(false)
    expect(breaker.shouldAttempt(key, until - 1).allowed).toBe(false)
    expect(breaker.shouldAttempt(key, until).allowed).toBe(true)
  })

  it("escalates the block on consecutive failures", () => {
    const first = breaker.recordFailure(key, failure(), NOW, noJitter)
    const second = breaker.recordFailure(key, failure(), NOW, noJitter)
    expect(second - NOW).toBe((first - NOW) * 2)
    expect(breaker.peek(key).consecutiveFailures).toBe(2)
  })

  it("merges blocks with MAX so a later short block cannot shorten a long one", () => {
    // Two surfaces observe the same outage. The second must not talk the first
    // one's two-hour block down to thirty seconds.
    const long = breaker.recordFailure(
      key,
      failure({ reason: "account-quota", retryAfterMs: 2 * 60 * 60_000 }),
      NOW,
      noJitter
    )
    const after = breaker.recordFailure(key, failure({ retryAfterMs: 1_000 }), NOW, noJitter)
    expect(after).toBe(long)
    expect(breaker.shouldAttempt(key, NOW + 60_000).allowed).toBe(false)
  })

  it("latches a permanent failure and never lifts it on its own", () => {
    breaker.recordFailure(key, failure({ reason: "auth-revoked", permanent: true }), NOW)
    const decision = breaker.shouldAttempt(key, NOW + 10 * 24 * 60 * 60_000)
    expect(decision.allowed).toBe(false)
    expect(decision.permanent).toBe(true)
    expect(decision.blockedUntil).toBe(Number.POSITIVE_INFINITY)
  })

  it("lifts a permanent latch only on an explicit clear", () => {
    breaker.recordFailure(key, failure({ reason: "auth-revoked", permanent: true }), NOW)
    breaker.clear(key)
    expect(breaker.shouldAttempt(key, NOW).allowed).toBe(true)
  })

  it("clears the block and the failure count on success", () => {
    breaker.recordFailure(key, failure(), NOW, noJitter)
    breaker.recordSuccess(key)
    expect(breaker.shouldAttempt(key, NOW).allowed).toBe(true)
    expect(breaker.peek(key).consecutiveFailures).toBe(0)
  })

  it("keeps scopes on one credential independent", () => {
    const usage = credentialKey("anthropic", "acct-1", BREAKER_SCOPES.usage)
    const refresh = credentialKey("anthropic", "acct-1", BREAKER_SCOPES.refresh)
    breaker.recordFailure(usage, failure(), NOW, noJitter)
    expect(breaker.shouldAttempt(usage, NOW).allowed).toBe(false)
    expect(breaker.shouldAttempt(refresh, NOW).allowed).toBe(true)
  })

  it("keeps accounts independent", () => {
    breaker.recordFailure(key, failure(), NOW, noJitter)
    const sibling = credentialKey("anthropic", "acct-2", BREAKER_SCOPES.usage)
    expect(breaker.shouldAttempt(sibling, NOW).allowed).toBe(true)
  })

  it("reports the reason alongside the block so the UI can explain it", () => {
    breaker.recordFailure(key, failure({ reason: "account-quota" }), NOW, noJitter)
    expect(breaker.shouldAttempt(key, NOW).reason).toBe("account-quota")
  })

  it("never hands out a live reference from peek", () => {
    breaker.recordFailure(key, failure(), NOW, noJitter)
    const snapshot = breaker.peek(key)
    snapshot.consecutiveFailures = 99
    expect(breaker.peek(key).consecutiveFailures).toBe(1)
  })
})

describe("the shared ledger", () => {
  afterEach(() => {
    __resetSubscriptionBreakerForTesting()
  })

  it("is one instance across callers", () => {
    expect(getSubscriptionBreaker()).toBe(getSubscriptionBreaker())
  })

  it("lets a block recorded by one surface gate another", () => {
    const key = credentialKey("codex", "acct-9", BREAKER_SCOPES.usage)
    getSubscriptionBreaker().recordFailure(key, failure(), NOW, noJitter)
    expect(getSubscriptionBreaker().shouldAttempt(key, NOW).allowed).toBe(false)
  })
})

describe("credentialKey", () => {
  it("separates provider, account and scope", () => {
    expect(credentialKey("anthropic", "a", "usage")).not.toBe(credentialKey("codex", "a", "usage"))
    expect(credentialKey("anthropic", "a", "usage")).not.toBe(
      credentialKey("anthropic", "b", "usage")
    )
    expect(credentialKey("anthropic", "a", "usage")).not.toBe(
      credentialKey("anthropic", "a", "refresh")
    )
  })
})
