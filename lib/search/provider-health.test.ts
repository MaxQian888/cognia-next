import {
  ProviderHealth,
  getProviderHealth,
  resetProviderHealth,
  DEFAULT_PROVIDER_HEALTH_CONFIG,
} from "./provider-health"
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
})
