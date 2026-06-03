import { useCircuitBreakerStore } from "./circuit-breaker-store"

describe("useCircuitBreakerStore", () => {
  beforeEach(() => {
    useCircuitBreakerStore.getState().resetAll()
    useCircuitBreakerStore.getState().setEnabled(false)
    useCircuitBreakerStore
      .getState()
      .setSettings({ failureThreshold: 2, cooldownMs: 50, successThreshold: 1 })
  })

  it("reports closed and available while disabled (no-op records)", () => {
    const s = useCircuitBreakerStore.getState()
    s.recordFailure("openai")
    s.recordFailure("openai")
    s.recordFailure("openai")
    expect(useCircuitBreakerStore.getState().getState("openai")).toBe("closed")
    expect(useCircuitBreakerStore.getState().isAvailable("openai")).toBe(true)
  })

  it("opens after the failure threshold when enabled", () => {
    const s = useCircuitBreakerStore.getState()
    s.setEnabled(true)
    s.recordFailure("openai")
    expect(useCircuitBreakerStore.getState().getState("openai")).toBe("closed")
    s.recordFailure("openai")
    expect(useCircuitBreakerStore.getState().getState("openai")).toBe("open")
    expect(useCircuitBreakerStore.getState().isAvailable("openai")).toBe(false)
  })

  it("resetBreaker clears a tripped provider", () => {
    const s = useCircuitBreakerStore.getState()
    s.setEnabled(true)
    s.recordFailure("p")
    s.recordFailure("p")
    expect(useCircuitBreakerStore.getState().getState("p")).toBe("open")
    s.resetBreaker("p")
    expect(useCircuitBreakerStore.getState().getState("p")).toBe("closed")
  })

  it("updateConfig overrides per-provider thresholds", () => {
    const s = useCircuitBreakerStore.getState()
    s.setEnabled(true)
    s.updateConfig("p", { failureThreshold: 1 })
    s.recordFailure("p")
    expect(useCircuitBreakerStore.getState().getState("p")).toBe("open")
  })
})
