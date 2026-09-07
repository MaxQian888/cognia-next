/**
 * Simulated provider scenarios for the retry layer.
 *
 * These are the cases the layer exists for, run as arithmetic over a fake
 * clock rather than as unit assertions on one function. Each one counts the
 * requests a real provider would have seen across a long window, and pins that
 * count. They are deliberately written as before-and-after comparisons, because
 * the number that matters is not "some backoff happened" but "how many times
 * did we knock on a door the server had already closed".
 *
 * Nothing here touches the network, a vault, or a real account.
 */

import { backoffDelayMs } from "./backoff"
import { SubscriptionBreaker, credentialKey } from "./breaker"
import { classifyThrownFailure } from "./failure-class"

const HOUR = 60 * 60_000
const MINUTE = 60_000

/** What the old code did: a flat 15 minute hold, armed only on a literal 429. */
const LEGACY_FLAT_BACKOFF_MS = 15 * MINUTE
const LEGACY_ARMS_ON = /(^|\s)429(\s|:|$)/

/**
 * Replay a polling loop against a provider that keeps returning `response`, and
 * count how many requests actually left the client.
 */
function simulate(options: {
  response: string
  windowMs: number
  pollEveryMs: number
  policy: "legacy" | "current"
}): number {
  const { response, windowMs, pollEveryMs, policy } = options
  const breaker = new SubscriptionBreaker()
  const key = credentialKey("anthropic", "acc-1", "usage")
  let legacyBlockedUntil = 0
  let requests = 0

  for (let now = 0; now <= windowMs; now += pollEveryMs) {
    if (policy === "legacy") {
      if (now < legacyBlockedUntil) continue
      requests += 1
      if (LEGACY_ARMS_ON.test(response)) legacyBlockedUntil = now + LEGACY_FLAT_BACKOFF_MS
      continue
    }
    if (!breaker.shouldAttempt(key, now).allowed) continue
    requests += 1
    // `random: () => 0` takes the bottom of the jitter band, so the counts
    // below are the WORST case for the current policy rather than a lucky one.
    breaker.recordFailure(key, classifyThrownFailure(response, now), now, () => 0)
  }
  return requests
}

describe("a provider that named a two hour reset window", () => {
  // The exact shape Anthropic and the CN coding plans return: a 429 whose body
  // says when the window reopens.
  const response = "429: Rate limited. Your limit will reset in 2 hours."

  it("used to be asked eight times inside its own window", () => {
    const legacy = simulate({
      response,
      windowMs: 2 * HOUR,
      pollEveryMs: 5 * MINUTE,
      policy: "legacy",
    })
    expect(legacy).toBe(9)
  })

  it("is now asked exactly once, then once more when the window reopens", () => {
    const current = simulate({
      response,
      windowMs: 2 * HOUR,
      pollEveryMs: 5 * MINUTE,
      policy: "current",
    })
    expect(current).toBe(2)
  })

  it("honors the named window rather than our own shorter ceiling", () => {
    // `throttled` caps OUR ramp at 15 minutes. The server asked for two hours.
    const delay = backoffDelayMs({
      reason: "throttled",
      consecutiveFailures: 1,
      retryAfterMs: 2 * HOUR,
      random: () => 0,
    })
    expect(delay).toBe(2 * HOUR)
  })
})

describe("a revoked refresh token", () => {
  // `invalid_grant` does not heal. Every repeat is a dead token posted to the
  // provider's token endpoint, which is the clearest way to get an account
  // flagged.
  const response = '400: {"error":"invalid_grant"}'

  it("used to be re-exchanged on every poll for as long as the app was open", () => {
    const legacy = simulate({
      response,
      windowMs: 8 * HOUR,
      pollEveryMs: 5 * MINUTE,
      policy: "legacy",
    })
    // The old backoff never armed here at all: the body carries no `429`.
    expect(legacy).toBe(97)
  })

  it("is now posted once and then latched until the user re-authenticates", () => {
    const current = simulate({
      response,
      windowMs: 8 * HOUR,
      pollEveryMs: 5 * MINUTE,
      policy: "current",
    })
    expect(current).toBe(1)
  })
})

describe("a 403 account cap and a 5xx outage", () => {
  it("used to arm nothing, so both were re-polled every five minutes", () => {
    for (const response of [
      "403: Reached overall message rate limit",
      "500: Internal Server Error",
    ]) {
      const legacy = simulate({
        response,
        windowMs: 2 * HOUR,
        pollEveryMs: 5 * MINUTE,
        policy: "legacy",
      })
      expect(legacy).toBe(25)
    }
  })

  it("now backs off, hard for the account cap and gently for the outage", () => {
    const cap = simulate({
      response: "403: Reached overall message rate limit",
      windowMs: 2 * HOUR,
      pollEveryMs: 5 * MINUTE,
      policy: "current",
    })
    const outage = simulate({
      response: "500: Internal Server Error",
      windowMs: 2 * HOUR,
      pollEveryMs: 5 * MINUTE,
      policy: "current",
    })
    // An account cap lasts hours, so two probes across two hours.
    expect(cap).toBe(3)
    // An outage may clear at any moment, so it is retried more eagerly, but on
    // a ramp rather than at a fixed five minutes.
    expect(outage).toBe(9)
    expect(outage).toBeLessThan(25)
  })
})

describe("a transient per-minute throttle", () => {
  it("is NOT punished with an account-length wait", () => {
    // The failure mode in the other direction: over-backing-off a throttle that
    // clears in seconds would freeze a healthy account's panel for half an hour.
    const requests = simulate({
      response: "429: Rate limit exceeded, 5 requests per minute",
      windowMs: HOUR,
      pollEveryMs: 5 * MINUTE,
      policy: "current",
    })
    expect(requests).toBeGreaterThan(3)
    expect(backoffDelayMs({ reason: "throttled", consecutiveFailures: 1, random: () => 0 })).toBe(
      30_000
    )
  })
})

describe("many credentials failing in the same sweep", () => {
  it("do not all come back at the same instant", () => {
    // Without jitter, N accounts that failed together wake together and the
    // retry lands as one burst instead of a trickle.
    const wakeUps = new Set<number>()
    for (let account = 0; account < 8; account++) {
      const roll = account / 8
      wakeUps.add(
        backoffDelayMs({
          reason: "capacity",
          consecutiveFailures: 1,
          random: () => roll,
        })
      )
    }
    expect(wakeUps.size).toBe(8)
  })
})

describe("the escalation ramp", () => {
  it("widens while a failure persists instead of holding one flat interval", () => {
    const breaker = new SubscriptionBreaker()
    const key = credentialKey("anthropic", "acc-1", "usage")
    const gaps: number[] = []
    let now = 0
    for (let attempt = 0; attempt < 4; attempt++) {
      const until = breaker.recordFailure(
        key,
        classifyThrownFailure("500: Internal Server Error", now),
        now,
        () => 0
      )
      gaps.push(until - now)
      now = until
    }
    expect(gaps).toEqual([20_000, 40_000, 80_000, 160_000])
  })
})
