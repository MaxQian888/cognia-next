import { DEFAULT_LOAD_BALANCER_SETTINGS, type LoadBalancerState } from "./load-balancer"

describe("DEFAULT_LOAD_BALANCER_SETTINGS", () => {
  it("uses adaptive routing with failover and circuit breaker enabled", () => {
    expect(DEFAULT_LOAD_BALANCER_SETTINGS).toMatchObject({
      enabled: true,
      strategy: "adaptive",
      stickySession: false,
      sessionTtl: 300000,
      minSuccessRate: 0.9,
      maxLatency: 5000,
      autoFailover: true,
      maxRetries: 3,
      circuitBreaker: {
        enabled: true,
        failureThreshold: 5,
        resetTimeout: 30000,
        successThreshold: 3,
      },
    })
  })
})

describe("LoadBalancerState contract", () => {
  it("tracks strategy, metrics, alternatives, and circuit states", () => {
    const state: LoadBalancerState = {
      activeStrategy: "priority",
      metrics: {},
      currentProvider: "openai",
      alternatives: ["anthropic"],
      circuitStates: { openai: "closed" },
      lastSelection: 10,
    }

    expect(state.alternatives).toEqual(["anthropic"])
    expect(state.circuitStates.openai).toBe("closed")
  })
})
