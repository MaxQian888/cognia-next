import { computeBackoffDelay } from "./backoff"

describe("computeBackoffDelay", () => {
  describe("ratio jitter (pre-cap)", () => {
    it("is deterministic with an injected rng and zero jitter", () => {
      const delay = computeBackoffDelay(2, {
        baseDelayMs: 1000,
        maxDelayMs: 60_000,
        jitter: { kind: "ratio", ratio: 0.25, rng: () => 0 },
      })
      // exponential = 1000 * 2^2 = 4000, jitter = 0
      expect(delay).toBe(4000)
    })

    it("adds jitter as a ratio of the exponential term before capping", () => {
      const delay = computeBackoffDelay(2, {
        baseDelayMs: 1000,
        maxDelayMs: 60_000,
        jitter: { kind: "ratio", ratio: 0.25, rng: () => 1 },
      })
      // exponential = 4000, jitter = 1 * 4000 * 0.25 = 1000 → 5000
      expect(delay).toBe(5000)
    })

    it("caps the exponential+jitter sum at maxDelayMs", () => {
      const delay = computeBackoffDelay(10, {
        baseDelayMs: 1000,
        maxDelayMs: 60_000,
        jitter: { kind: "ratio", ratio: 0.25, rng: () => 1 },
      })
      expect(delay).toBe(60_000)
    })

    it("defaults rng to Math.random when omitted", () => {
      const delay = computeBackoffDelay(0, {
        baseDelayMs: 1000,
        maxDelayMs: 60_000,
        jitter: { kind: "ratio", ratio: 0.25 },
      })
      // exponential = 1000, jitter in [0, 250) → delay in [1000, 1250)
      expect(delay).toBeGreaterThanOrEqual(1000)
      expect(delay).toBeLessThan(1250)
    })
  })

  describe("absolute jitter (post-cap)", () => {
    it("is deterministic with zero jitter", () => {
      const delay = computeBackoffDelay(0, {
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        jitter: { kind: "absolute", amountMs: () => 0 },
      })
      // exponential = 1000 * 2^0 = 1000
      expect(delay).toBe(1000)
    })

    it("adds jitter after the exponential is capped at maxDelayMs", () => {
      const delay = computeBackoffDelay(10, {
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        jitter: { kind: "absolute", amountMs: () => 500 },
      })
      // exponential(10) far exceeds 60_000, so it's capped to 60_000, then +500
      expect(delay).toBe(60_500)
    })

    it("matches outbound-runner's documented formula for a mid-range attempt", () => {
      const delay = computeBackoffDelay(3, {
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        jitter: { kind: "absolute", amountMs: () => 250 },
      })
      // exponential = 1000 * 2^3 = 8000, under cap, + 250 jitter
      expect(delay).toBe(8250)
    })
  })
})
