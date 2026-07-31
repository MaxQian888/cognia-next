import {
  __resetRegistryForTesting,
  activationBreakerKey,
  breakerKey,
  getOrCreateBreaker,
  loadBreakerKey,
  resetPluginBreakers,
  snapshotAll,
  snapshotKey,
  type PluginBreakerConfig,
} from "@/lib/plugin/resilience/breaker-registry"

const CONFIG: PluginBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 30_000,
  successThreshold: 2,
}

describe("breaker-registry", () => {
  beforeEach(() => __resetRegistryForTesting())

  it("derives stable keys", () => {
    expect(breakerKey("p", "t")).toBe("p::t")
    expect(loadBreakerKey("p")).toBe("load:p")
    expect(activationBreakerKey("p")).toBe("activation:p")
  })

  it("lazily creates one breaker per key and returns the same instance", () => {
    const a = getOrCreateBreaker(breakerKey("p", "t"), CONFIG)
    const b = getOrCreateBreaker(breakerKey("p", "t"), CONFIG)
    expect(a).toBe(b)
  })

  it("isolates breakers per tool", () => {
    const t1 = getOrCreateBreaker(breakerKey("p", "t1"), CONFIG)
    const t2 = getOrCreateBreaker(breakerKey("p", "t2"), CONFIG)
    expect(t1).not.toBe(t2)
  })

  it("opens after failureThreshold consecutive failures", () => {
    const breaker = getOrCreateBreaker(breakerKey("p", "t"), CONFIG)
    expect(breaker.canPass()).toBe(true)
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.state()).toBe("closed")
    breaker.recordFailure()
    expect(breaker.state()).toBe("open")
    expect(breaker.canPass()).toBe(false)
  })

  it("resetPluginBreakers drops only the matching plugin's keys", () => {
    getOrCreateBreaker(breakerKey("p", "t"), CONFIG)
    getOrCreateBreaker(loadBreakerKey("p"), CONFIG)
    getOrCreateBreaker(activationBreakerKey("p"), CONFIG)
    getOrCreateBreaker(breakerKey("other", "t"), CONFIG)

    resetPluginBreakers("p")

    const keys = Object.keys(snapshotAll())
    expect(keys).toEqual(["other::t"])
  })

  it("snapshotAll / snapshotKey return pure reads", () => {
    const breaker = getOrCreateBreaker(breakerKey("p", "t"), CONFIG)
    breaker.recordFailure()
    const all = snapshotAll()
    expect(all["p::t"].state).toBe("closed")
    expect(snapshotKey("p::t")).not.toBeNull()
    expect(snapshotKey("missing")).toBeNull()
  })
})
