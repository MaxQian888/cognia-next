import { BACKOFF_POLICIES, backoffDelayMs, blockedUntil, jitterCadenceMs } from "./backoff"
import { MAX_RETRY_HINT_MS } from "./retry-hint"

/** Deterministic jitter: 0 adds nothing, so the base delay is exact. */
const noJitter = () => 0
/** Deterministic jitter: 1 adds the full ratio. */
const fullJitter = () => 1

describe("backoffDelayMs", () => {
  it("returns zero before any failure", () => {
    expect(backoffDelayMs({ reason: "throttled", consecutiveFailures: 0 })).toBe(0)
  })

  it("starts at the per-reason base and doubles", () => {
    const base = BACKOFF_POLICIES.throttled.baseMs
    const at = (n: number) =>
      backoffDelayMs({ reason: "throttled", consecutiveFailures: n, random: noJitter })
    expect(at(1)).toBe(base)
    expect(at(2)).toBe(base * 2)
    expect(at(3)).toBe(base * 4)
  })

  it("caps our own ramp at the per-reason ceiling", () => {
    const delay = backoffDelayMs({
      reason: "throttled",
      consecutiveFailures: 40,
      random: noJitter,
    })
    expect(delay).toBe(BACKOFF_POLICIES.throttled.maxMs)
  })

  it("gives an account quota a far longer ramp than a throttle", () => {
    const quota = backoffDelayMs({
      reason: "account-quota",
      consecutiveFailures: 1,
      random: noJitter,
    })
    const throttle = backoffDelayMs({
      reason: "throttled",
      consecutiveFailures: 1,
      random: noJitter,
    })
    expect(quota).toBeGreaterThan(throttle * 10)
  })

  it("honors a server hint that is longer than our ramp", () => {
    const twoHours = 2 * 60 * 60_000
    const delay = backoffDelayMs({
      reason: "throttled",
      consecutiveFailures: 1,
      retryAfterMs: twoHours,
      random: noJitter,
    })
    expect(delay).toBe(twoHours)
  })

  it("does NOT clip a server hint down to our ceiling", () => {
    // This is the anti-storm rule. `throttled` caps our own ramp at 15 min, but
    // a provider asking for 2h must get 2h, or one 429 becomes eight.
    const twoHours = 2 * 60 * 60_000
    const delay = backoffDelayMs({
      reason: "throttled",
      consecutiveFailures: 1,
      retryAfterMs: twoHours,
      random: noJitter,
    })
    expect(delay).toBeGreaterThan(BACKOFF_POLICIES.throttled.maxMs)
  })

  it("keeps our ramp when the hint is shorter", () => {
    const delay = backoffDelayMs({
      reason: "account-quota",
      consecutiveFailures: 1,
      retryAfterMs: 1_000,
      random: noJitter,
    })
    expect(delay).toBe(BACKOFF_POLICIES["account-quota"].baseMs)
  })

  it("treats an explicit zero hint as retry-now and suppresses the ramp", () => {
    const delay = backoffDelayMs({
      reason: "throttled",
      consecutiveFailures: 3,
      retryAfterMs: 0,
      random: noJitter,
    })
    expect(delay).toBe(0)
  })

  it("adds jitter bounded by the policy ratio", () => {
    const base = BACKOFF_POLICIES.capacity.baseMs
    const ratio = BACKOFF_POLICIES.capacity.jitterRatio
    const low = backoffDelayMs({ reason: "capacity", consecutiveFailures: 1, random: noJitter })
    const high = backoffDelayMs({ reason: "capacity", consecutiveFailures: 1, random: fullJitter })
    expect(low).toBe(base)
    expect(high).toBe(Math.round(base * (1 + ratio)))
  })

  it("never exceeds the 24h absolute ceiling", () => {
    const delay = backoffDelayMs({
      reason: "account-quota",
      consecutiveFailures: 60,
      retryAfterMs: MAX_RETRY_HINT_MS,
      random: fullJitter,
    })
    expect(delay).toBeLessThanOrEqual(MAX_RETRY_HINT_MS)
  })

  it("gives every reason a policy", () => {
    for (const [reason, policy] of Object.entries(BACKOFF_POLICIES)) {
      expect(policy.baseMs).toBeGreaterThan(0)
      expect(policy.maxMs).toBeGreaterThanOrEqual(policy.baseMs)
      expect(policy.jitterRatio).toBeGreaterThan(0)
      expect(reason).toBeTruthy()
    }
  })
})

describe("blockedUntil", () => {
  it("offsets the delay from the supplied clock", () => {
    const now = 1_000_000
    const at = blockedUntil(now, {
      reason: "concurrency",
      consecutiveFailures: 1,
      random: noJitter,
    })
    expect(at).toBe(now + BACKOFF_POLICIES.concurrency.baseMs)
  })
})

describe("jitterCadenceMs", () => {
  it("spreads upward from the configured cadence", () => {
    const cadence = 300_000
    expect(jitterCadenceMs(cadence, 0.2, () => 0)).toBe(cadence)
    expect(jitterCadenceMs(cadence, 0.2, () => 1)).toBe(cadence + 60_000)
    expect(jitterCadenceMs(cadence, 0.2, () => 0.5)).toBe(cadence + 30_000)
  })

  it("never returns less than the cadence, because callers treat it as a floor", () => {
    const cadence = 60_000
    for (const roll of [0, 0.1, 0.5, 0.9, 1]) {
      expect(jitterCadenceMs(cadence, 0.2, () => roll)).toBeGreaterThanOrEqual(cadence)
    }
  })

  it("ignores a negative ratio rather than pulling the delay below the cadence", () => {
    expect(jitterCadenceMs(60_000, -0.5, () => 1)).toBe(60_000)
  })

  it("returns zero for a nonsense cadence", () => {
    expect(jitterCadenceMs(0)).toBe(0)
    expect(jitterCadenceMs(Number.NaN)).toBe(0)
    expect(jitterCadenceMs(-5)).toBe(0)
  })
})
