import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_MAX_COOLDOWN_MS,
  DEFAULT_MIN_REQUEST_VOLUME,
  INITIAL_CIRCUIT_BREAKER_STATE,
  type CircuitBreakerStoreState,
} from "./circuit-breaker"

describe("circuit breaker defaults", () => {
  it("sets count-based defaults and retry-after guardrails", () => {
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG).toEqual({
      failureThreshold: 5,
      windowDurationMs: 60000,
      cooldownMs: 30000,
      successThreshold: 1,
    })
    expect(DEFAULT_MIN_REQUEST_VOLUME).toBe(10)
    expect(DEFAULT_MAX_COOLDOWN_MS).toBe(600_000)
  })

  it("starts closed with no counters", () => {
    expect(INITIAL_CIRCUIT_BREAKER_STATE).toMatchObject({
      state: "closed",
      failureCount: 0,
      successCount: 0,
      lastFailureAt: null,
      openedAt: null,
      blockedCount: 0,
    })
    expect(INITIAL_CIRCUIT_BREAKER_STATE.lastTransitionAt).toEqual(expect.any(Number))
  })
})

describe("CircuitBreakerStoreState contract", () => {
  it("allows provider and deployment level availability checks", () => {
    const store: Pick<
      CircuitBreakerStoreState,
      "getState" | "getDeploymentState" | "isAvailable" | "isDeploymentAvailable"
    > = {
      getState: () => "closed",
      getDeploymentState: () => "half-open",
      isAvailable: () => true,
      isDeploymentAvailable: () => true,
    }

    expect(store.getState("openai")).toBe("closed")
    expect(store.getDeploymentState("openai::gpt-4o")).toBe("half-open")
  })
})
