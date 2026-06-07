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

describe("Retry-After dynamic cooldown", () => {
  const tripAt = (retryAfterMs: number | undefined, cfg = config): CircuitBreakerState => {
    let s = fresh()
    s = recordFailure(s, cfg, 100)
    s = recordFailure(s, cfg, 200)
    s = recordFailure(s, cfg, 300, { retryAfterMs })
    expect(s.state).toBe("open")
    return s
  }

  it("extends the open window to the Retry-After hint", () => {
    const s = tripAt(2000)
    expect(s.dynamicCooldownMs).toBe(2000)
    // Default cooldown (500ms) elapsed but the dynamic one has not.
    expect(currentStateValue(s, config, 300 + 600)).toBe("open")
    expect(currentStateValue(s, config, 300 + 2000)).toBe("half-open")
  })

  it("honors a Retry-After SHORTER than the configured cooldown", () => {
    const s = tripAt(100)
    expect(currentStateValue(s, config, 300 + 150)).toBe("half-open")
  })

  it("clamps hostile values to maxCooldownMs", () => {
    const cfg = { ...config, maxCooldownMs: 1000 }
    const s = tripAt(999_999_999, cfg)
    expect(s.dynamicCooldownMs).toBe(1000)
  })

  it("ignores non-positive or non-finite hints", () => {
    expect(tripAt(0).dynamicCooldownMs).toBeUndefined()
    expect(tripAt(-5).dynamicCooldownMs).toBeUndefined()
    expect(tripAt(Number.NaN).dynamicCooldownMs).toBeUndefined()
  })

  it("applies the hint when a half-open probe fails", () => {
    let s = tripAt(undefined)
    s = recordFailure(s, config, 300 + 600, { retryAfterMs: 5000 }) // probe fails
    expect(s.state).toBe("open")
    expect(s.dynamicCooldownMs).toBe(5000)
  })

  it("clears the dynamic cooldown when the breaker closes", () => {
    let s = tripAt(2000)
    s = recordSuccess(s, config, 300 + 2000) // probe #1
    s = recordSuccess(s, config, 300 + 2100) // probe #2 → close
    expect(s.state).toBe("closed")
    expect(s.dynamicCooldownMs).toBeUndefined()
  })
})

describe("failure-rate mode", () => {
  const rateConfig: CircuitBreakerConfig = {
    ...config,
    failureThreshold: 100, // absolute guard far away
    failureRateThreshold: 0.5,
    minRequestVolume: 4,
  }

  it("does not trip below the minimum request volume", () => {
    let s = fresh()
    s = recordFailure(s, rateConfig, 100)
    s = recordFailure(s, rateConfig, 110)
    s = recordFailure(s, rateConfig, 120)
    expect(s.state).toBe("closed") // 3 requests < minVolume 4
  })

  it("trips when the failure ratio reaches the threshold at volume", () => {
    let s = fresh()
    s = recordSuccess(s, rateConfig, 100)
    s = recordSuccess(s, rateConfig, 110)
    s = recordFailure(s, rateConfig, 120)
    expect(s.state).toBe("closed") // 1/3
    s = recordFailure(s, rateConfig, 130)
    expect(s.state).toBe("open") // 2/4 = 0.5 >= 0.5 @ volume 4
  })

  it("successes contribute volume and do not clear the streak", () => {
    let s = fresh()
    s = recordFailure(s, rateConfig, 100)
    s = recordSuccess(s, rateConfig, 110)
    expect(s.failureCount).toBe(1) // streak NOT cleared in rate mode
    expect(s.windowRequestCount).toBe(2)
  })

  it("a healthy stream keeps the ratio below threshold", () => {
    let s = fresh()
    for (let i = 0; i < 6; i++) s = recordSuccess(s, rateConfig, 100 + i)
    s = recordFailure(s, rateConfig, 110)
    s = recordFailure(s, rateConfig, 120)
    expect(s.state).toBe("closed") // 2/8 = 0.25 < 0.5
  })

  it("resets counters when the window expires", () => {
    let s = fresh()
    s = recordFailure(s, rateConfig, 100)
    s = recordFailure(s, rateConfig, 200)
    s = recordFailure(s, rateConfig, 5000) // window (1000ms) expired
    expect(s.failureCount).toBe(1)
    expect(s.windowRequestCount).toBe(1)
    expect(s.state).toBe("closed")
  })

  it("keeps the absolute threshold as a hard guard", () => {
    const cfg = { ...rateConfig, failureThreshold: 2, minRequestVolume: 100 }
    let s = fresh()
    s = recordFailure(s, cfg, 100)
    s = recordFailure(s, cfg, 110)
    expect(s.state).toBe("open") // absolute guard despite volume < 100
  })

  it("uses the default minimum volume when unset", () => {
    const cfg: CircuitBreakerConfig = {
      ...config,
      failureThreshold: 100,
      failureRateThreshold: 0.5,
    }
    let s = fresh()
    for (let i = 0; i < 9; i++) s = recordFailure(s, cfg, 100 + i)
    expect(s.state).toBe("closed") // 9 < DEFAULT_MIN_REQUEST_VOLUME (10)
    s = recordFailure(s, cfg, 120)
    expect(s.state).toBe("open") // 10/10 @ default volume 10
  })
})
