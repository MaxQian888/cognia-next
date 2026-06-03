import { recordSuccess, recordFailure, currentStateValue } from "./circuit-breaker-machine"
import {
  INITIAL_CIRCUIT_BREAKER_STATE,
  type CircuitBreakerConfig,
  type CircuitBreakerState,
} from "@/types/provider/circuit-breaker"

const config: CircuitBreakerConfig = {
  failureThreshold: 3,
  windowDurationMs: 1000,
  cooldownMs: 500,
  successThreshold: 2,
}

const fresh = (): CircuitBreakerState => ({ ...INITIAL_CIRCUIT_BREAKER_STATE, lastTransitionAt: 0 })

describe("recordFailure → open", () => {
  it("opens after failureThreshold failures within the window", () => {
    let s = fresh()
    s = recordFailure(s, config, 100)
    expect(s.state).toBe("closed")
    expect(s.failureCount).toBe(1)
    s = recordFailure(s, config, 200)
    expect(s.state).toBe("closed")
    s = recordFailure(s, config, 300)
    expect(s.state).toBe("open")
    expect(s.openedAt).toBe(300)
  })

  it("resets the streak when the window expires between failures", () => {
    let s = fresh()
    s = recordFailure(s, config, 100)
    s = recordFailure(s, config, 200)
    // Gap > windowDurationMs → counter resets to 1, not 3.
    s = recordFailure(s, config, 2000)
    expect(s.state).toBe("closed")
    expect(s.failureCount).toBe(1)
  })
})

describe("open → half-open → closed", () => {
  const opened = (): CircuitBreakerState => ({
    ...fresh(),
    state: "open",
    failureCount: 3,
    openedAt: 1000,
    lastFailureAt: 1000,
  })

  it("reports half-open once the cooldown elapses", () => {
    const s = opened()
    expect(currentStateValue(s, config, 1200)).toBe("open") // 200 < 500 cooldown
    expect(currentStateValue(s, config, 1600)).toBe("half-open") // 600 >= 500
  })

  it("closes after successThreshold successful probes", () => {
    let s = opened()
    s = recordSuccess(s, config, 1600) // half-open probe #1
    expect(s.state).toBe("half-open")
    expect(s.successCount).toBe(1)
    s = recordSuccess(s, config, 1700) // probe #2 → close
    expect(s.state).toBe("closed")
    expect(s.failureCount).toBe(0)
    expect(s.openedAt).toBeNull()
  })

  it("re-opens immediately if a probe fails in half-open", () => {
    let s = opened()
    s = recordSuccess(s, config, 1600) // probe #1 ok
    s = recordFailure(s, config, 1650) // probe fails → reopen
    expect(s.state).toBe("open")
    expect(s.openedAt).toBe(1650)
  })
})

describe("recordSuccess in closed state", () => {
  it("clears a partial failure streak", () => {
    let s = fresh()
    s = recordFailure(s, config, 100)
    expect(s.failureCount).toBe(1)
    s = recordSuccess(s, config, 150)
    expect(s.state).toBe("closed")
    expect(s.failureCount).toBe(0)
  })

  it("is a no-op object-wise when already clean", () => {
    const s = fresh()
    expect(recordSuccess(s, config, 10)).toBe(s)
  })
})
