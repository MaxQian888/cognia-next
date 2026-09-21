import {
  ProviderHealth,
  getProviderHealth,
  resetProviderHealth,
  DEFAULT_PROVIDER_HEALTH_CONFIG,
} from "./provider-health"
import { DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS } from "./types"
import type { SearchProviderType } from "./types"

function p(id: SearchProviderType) {
  return { providerId: id }
}

describe("ProviderHealth circuit breaker", () => {
  it("stays closed below the failure threshold", () => {
    const t = 1000
    const h = new ProviderHealth({ failureThreshold: 3, cooldownMs: 100 }, () => t)
    h.recordResult("tavily", false)
    h.recordResult("tavily", false)
    expect(h.circuitState("tavily")).toBe("closed")
    expect(h.isOpen("tavily")).toBe(false)
  })

  it("opens after the threshold and half-opens after the cooldown", () => {
    let t = 1000
    const h = new ProviderHealth({ failureThreshold: 3, cooldownMs: 100 }, () => t)
    h.recordResult("tavily", false)
    h.recordResult("tavily", false)
    h.recordResult("tavily", false)
    expect(h.circuitState("tavily")).toBe("open")
    expect(h.isOpen("tavily")).toBe(true)
    t = 1099
    expect(h.circuitState("tavily")).toBe("open")
    t = 1100
    expect(h.circuitState("tavily")).toBe("half-open")
    expect(h.isOpen("tavily")).toBe(false)
  })

  it("a success closes the circuit and resets the failure count", () => {
    const t = 1000
    const h = new ProviderHealth({ failureThreshold: 2, cooldownMs: 100 }, () => t)
    h.recordResult("exa", false)
    h.recordResult("exa", false)
    expect(h.circuitState("exa")).toBe("open")
    h.recordResult("exa", true)
    expect(h.circuitState("exa")).toBe("closed")
  })

  it("orderByHealth pushes still-open providers to the back, stably", () => {
    const t = 1000
    const h = new ProviderHealth({ failureThreshold: 1, cooldownMs: 1000 }, () => t)
    h.recordResult("tavily", false) // opens tavily
    const ordered = h.orderByHealth([p("tavily"), p("exa"), p("brave")])
    expect(ordered.map((x) => x.providerId)).toEqual(["exa", "brave", "tavily"])
  })

  it("orderByHealth is identity when nothing is open", () => {
    const h = new ProviderHealth({}, () => 1000)
    const providers = [p("tavily"), p("exa")]
    expect(h.orderByHealth(providers)).toBe(providers)
  })

  it("is a no-op when disabled", () => {
    const h = new ProviderHealth({ enabled: false, failureThreshold: 1 }, () => 1000)
    h.recordResult("tavily", false)
    expect(h.isOpen("tavily")).toBe(false)
    const providers = [p("tavily"), p("exa")]
    expect(h.orderByHealth(providers)).toBe(providers)
  })

  it("snapshot reports the shared SearchProviderHealth shape", () => {
    const t = 1000
    const h = new ProviderHealth({ failureThreshold: 2, cooldownMs: 100 }, () => t)
    expect(h.snapshot("bing").status).toBe("unknown")
    h.recordResult("bing", true)
    expect(h.snapshot("bing").status).toBe("healthy")
    expect(h.snapshot("bing").successRate).toBe(1)
    h.recordResult("bing", false)
    h.recordResult("bing", false)
    const snap = h.snapshot("bing")
    expect(snap.circuitBreakerOpen).toBe(true)
    expect(snap.status).toBe("unhealthy")
  })

  it("snapshot reports the rounded mean of recorded success latencies", () => {
    const h = new ProviderHealth({}, () => 1000)
    expect(h.snapshot("tavily").avgLatency).toBe(0)
    h.recordResult("tavily", true, 100)
    h.recordResult("tavily", true, 201)
    h.recordResult("tavily", false) // failures never feed the latency average
    expect(h.snapshot("tavily").avgLatency).toBe(151)
  })

  it("ignores missing, non-finite, and negative latencies", () => {
    const h = new ProviderHealth({}, () => 1000)
    h.recordResult("tavily", true)
    h.recordResult("tavily", true, Number.NaN)
    h.recordResult("tavily", true, Number.POSITIVE_INFINITY)
    h.recordResult("tavily", true, -5)
    h.recordResult("tavily", true, 200)
    // Five successes recorded, only one carried a usable latency — the average
    // covers sampled successes only, so the missing timers do not dilute it.
    expect(h.snapshot("tavily").avgLatency).toBe(200)
  })

  it("cooldownRemainingMs counts down to zero with the injected clock", () => {
    let t = 1000
    const h = new ProviderHealth({ failureThreshold: 1, cooldownMs: 300 }, () => t)
    expect(h.cooldownRemainingMs("tavily")).toBe(0)
    h.recordResult("tavily", false)
    expect(h.cooldownRemainingMs("tavily")).toBe(300)
    t = 1150
    expect(h.cooldownRemainingMs("tavily")).toBe(150)
    t = 1300
    // Past the cooldown the circuit is half-open, not open — remaining is 0.
    expect(h.circuitState("tavily")).toBe("half-open")
    expect(h.cooldownRemainingMs("tavily")).toBe(0)
  })

  it("cooldownRemainingMs is 0 while the breaker is disabled", () => {
    const h = new ProviderHealth({ enabled: false, failureThreshold: 1 }, () => 1000)
    h.recordResult("tavily", false)
    expect(h.cooldownRemainingMs("tavily")).toBe(0)
  })

  it("getConfig returns a defensive copy", () => {
    const h = new ProviderHealth({ failureThreshold: 4 }, () => 1000)
    const config = h.getConfig()
    expect(config).toEqual({
      enabled: true,
      failureThreshold: 4,
      cooldownMs: DEFAULT_PROVIDER_HEALTH_CONFIG.cooldownMs,
    })
    config.failureThreshold = 99
    expect(h.getConfig().failureThreshold).toBe(4)
  })

  it("snapshotAll returns one row per requested id with counters and circuit position", () => {
    let t = 1000
    const h = new ProviderHealth({ failureThreshold: 2, cooldownMs: 500 }, () => t)
    h.recordResult("tavily", true, 100)
    h.recordResult("tavily", false)
    h.recordResult("tavily", false) // opens
    h.recordResult("exa", true, 50)

    const rows = h.snapshotAll(["tavily", "exa", "bing"])
    expect(Object.keys(rows).sort()).toEqual(["bing", "exa", "tavily"])

    expect(rows.tavily).toMatchObject({
      status: "unhealthy",
      avgLatency: 100,
      circuitBreakerOpen: true,
      circuitState: "open",
      cooldownRemainingMs: 500,
      totalFailures: 2,
      totalSuccesses: 1,
      consecutiveFailures: 2,
    })
    expect(rows.exa).toMatchObject({
      status: "healthy",
      avgLatency: 50,
      circuitState: "closed",
      cooldownRemainingMs: 0,
      totalSuccesses: 1,
    })
    // Untouched provider still gets a well-formed row.
    expect(rows.bing).toMatchObject({
      status: "unknown",
      circuitState: "closed",
      totalFailures: 0,
      totalSuccesses: 0,
      consecutiveFailures: 0,
    })

    t = 1400
    expect(h.snapshotAll(["tavily"]).tavily.cooldownRemainingMs).toBe(100)
  })

  it("reset clears state for one provider or all", () => {
    const h = new ProviderHealth({ failureThreshold: 1 }, () => 1000)
    h.recordResult("tavily", false)
    h.recordResult("exa", false)
    h.reset("tavily")
    expect(h.isOpen("tavily")).toBe(false)
    expect(h.isOpen("exa")).toBe(true)
    h.reset()
    expect(h.isOpen("exa")).toBe(false)
  })
})

describe("shared singleton", () => {
  afterEach(() => resetProviderHealth())

  it("returns the same instance until reset", () => {
    const a = getProviderHealth()
    expect(getProviderHealth()).toBe(a)
    resetProviderHealth()
    expect(getProviderHealth()).not.toBe(a)
  })

  it("exposes sensible defaults", () => {
    expect(DEFAULT_PROVIDER_HEALTH_CONFIG.failureThreshold).toBeGreaterThan(0)
    expect(DEFAULT_PROVIDER_HEALTH_CONFIG.cooldownMs).toBeGreaterThan(0)
    expect(DEFAULT_PROVIDER_HEALTH_CONFIG.enabled).toBe(true)
  })

  it("derives its defaults from the persisted-settings default", () => {
    // The runtime default and the settings default are one value — the spread
    // keeps them from drifting apart.
    expect(DEFAULT_PROVIDER_HEALTH_CONFIG).toEqual(DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS)
  })
})
