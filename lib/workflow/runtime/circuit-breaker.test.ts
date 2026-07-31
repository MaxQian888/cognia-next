import {
  CircuitOpenError,
  assertCircuitClosed,
  isCircuitOpen,
  recordCircuitFailure,
  recordCircuitSuccess,
  resetCircuitBreaker,
  type CircuitBreakerConfig,
} from "./circuit-breaker"

const WF = "wf_1"
const NODE = "n_1"
const config: CircuitBreakerConfig = { threshold: 3, cooldownMs: 1000 }

beforeEach(() => resetCircuitBreaker())

describe("circuit-breaker", () => {
  it("stays closed before the threshold is reached", () => {
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0)
    expect(isCircuitOpen(WF, NODE, 0)).toBe(false)
    expect(() => assertCircuitClosed(WF, NODE, 0)).not.toThrow()
  })

  it("opens once consecutive failures hit the threshold", () => {
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0)
    expect(isCircuitOpen(WF, NODE, 0)).toBe(true)
    expect(() => assertCircuitClosed(WF, NODE, 500)).toThrow(CircuitOpenError)
  })

  it("CircuitOpenError is non-retryable and carries openUntil + code", () => {
    recordCircuitFailure(WF, NODE, config, 100)
    recordCircuitFailure(WF, NODE, config, 100)
    recordCircuitFailure(WF, NODE, config, 100)
    try {
      assertCircuitClosed(WF, NODE, 100)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(CircuitOpenError)
      const err = e as CircuitOpenError
      expect(err.retryable).toBe(false)
      expect(err.code).toBe("circuit_open")
      expect(err.openUntil).toBe(1100)
    }
  })

  it("goes half-open after the cooldown elapses (allows a trial)", () => {
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0) // opens until 1000
    expect(isCircuitOpen(WF, NODE, 999)).toBe(true)
    expect(isCircuitOpen(WF, NODE, 1000)).toBe(false)
    expect(isCircuitOpen(WF, NODE, 1500)).toBe(false)
  })

  it("a failure while half-open re-opens immediately", () => {
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0) // opens until 1000
    // half-open at 1500, trial fails → reopens until 2500
    recordCircuitFailure(WF, NODE, config, 1500)
    expect(isCircuitOpen(WF, NODE, 1500)).toBe(true)
    expect(isCircuitOpen(WF, NODE, 2499)).toBe(true)
    expect(isCircuitOpen(WF, NODE, 2500)).toBe(false)
  })

  it("a success closes the breaker and resets the counter", () => {
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitSuccess(WF, NODE)
    expect(isCircuitOpen(WF, NODE, 0)).toBe(false)
    // counter reset → needs a fresh full streak to open again
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0)
    expect(isCircuitOpen(WF, NODE, 0)).toBe(false)
  })

  it("tracks breakers per (workflowId, nodeId) independently", () => {
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0)
    expect(isCircuitOpen(WF, NODE, 0)).toBe(true)
    expect(isCircuitOpen(WF, "n_other", 0)).toBe(false)
    expect(isCircuitOpen("wf_other", NODE, 0)).toBe(false)
  })

  it("clamps threshold to ≥1 and cooldown to ≥0", () => {
    recordCircuitFailure(WF, NODE, { threshold: 0, cooldownMs: -5 }, 0)
    // threshold floored to 1 → opens on the first failure; cooldown floored to 0
    expect(isCircuitOpen(WF, NODE, 0)).toBe(false) // openUntil = 0, now = 0 → 0 < 0 is false
    expect(isCircuitOpen(WF, NODE, -1)).toBe(true)
  })

  it("resetCircuitBreaker(pair) clears only that node", () => {
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, NODE, config, 0)
    recordCircuitFailure(WF, "n_2", config, 0)
    recordCircuitFailure(WF, "n_2", config, 0)
    recordCircuitFailure(WF, "n_2", config, 0)
    resetCircuitBreaker(WF, NODE)
    expect(isCircuitOpen(WF, NODE, 0)).toBe(false)
    expect(isCircuitOpen(WF, "n_2", 0)).toBe(true)
  })
})
