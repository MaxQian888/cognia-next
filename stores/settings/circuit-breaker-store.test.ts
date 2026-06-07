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

  describe("deployment granularity", () => {
    it("trips one deployment without blackholing the provider", () => {
      const s = useCircuitBreakerStore.getState()
      s.setEnabled(true)
      s.recordFailure("openai", { modelId: "gpt-4o" })
      s.recordFailure("openai", { modelId: "gpt-4o" })
      s.recordSuccess("openai", { modelId: "gpt-4o-mini" })
      const st = useCircuitBreakerStore.getState()
      expect(st.getDeploymentState("openai::gpt-4o")).toBe("open")
      expect(st.isDeploymentAvailable("openai::gpt-4o")).toBe(false)
      expect(st.getDeploymentState("openai::gpt-4o-mini")).toBe("closed")
      // Provider-level reduce: best state wins → still routable.
      expect(st.getState("openai")).toBe("closed")
      expect(st.isAvailable("openai")).toBe(true)
    })

    it("provider goes open only when every tracked deployment is open", () => {
      const s = useCircuitBreakerStore.getState()
      s.setEnabled(true)
      for (const m of ["a", "b"]) {
        s.recordFailure("p", { modelId: m })
        s.recordFailure("p", { modelId: m })
      }
      expect(useCircuitBreakerStore.getState().getState("p")).toBe("open")
      expect(useCircuitBreakerStore.getState().isAvailable("p")).toBe(false)
    })

    it("provider-only records land in the wildcard deployment (legacy parity)", () => {
      const s = useCircuitBreakerStore.getState()
      s.setEnabled(true)
      s.recordFailure("openai")
      s.recordFailure("openai")
      const st = useCircuitBreakerStore.getState()
      expect(st.getDeploymentState("openai::*")).toBe("open")
      expect(st.getState("openai")).toBe("open")
    })

    it("keyId separates breakers for multi-key rotation", () => {
      const s = useCircuitBreakerStore.getState()
      s.setEnabled(true)
      s.recordFailure("openai", { modelId: "gpt-4o", keyId: "k1" })
      s.recordFailure("openai", { modelId: "gpt-4o", keyId: "k1" })
      const st = useCircuitBreakerStore.getState()
      expect(st.getDeploymentState("openai::gpt-4o::k1")).toBe("open")
      expect(st.getDeploymentState("openai::gpt-4o::k2")).toBe("closed")
    })

    it("updateConfig applies to existing and future deployments of the provider", () => {
      const s = useCircuitBreakerStore.getState()
      s.setEnabled(true)
      s.recordFailure("p", { modelId: "existing" }) // 1 failure, threshold 2 → closed
      s.updateConfig("p", { failureThreshold: 1 })
      s.recordFailure("p", { modelId: "existing" })
      expect(useCircuitBreakerStore.getState().getDeploymentState("p::existing")).toBe("open")
      s.recordFailure("p", { modelId: "future" })
      expect(useCircuitBreakerStore.getState().getDeploymentState("p::future")).toBe("open")
    })

    it("resetBreaker clears every deployment of the provider", () => {
      const s = useCircuitBreakerStore.getState()
      s.setEnabled(true)
      s.recordFailure("p", { modelId: "a" })
      s.recordFailure("p", { modelId: "a" })
      s.recordFailure("p")
      s.recordFailure("p")
      expect(useCircuitBreakerStore.getState().getState("p")).toBe("open")
      s.resetBreaker("p")
      const st = useCircuitBreakerStore.getState()
      expect(st.getDeploymentState("p::a")).toBe("closed")
      expect(st.getDeploymentState("p::*")).toBe("closed")
    })

    it("isDeploymentAvailable is always true while disabled", () => {
      const s = useCircuitBreakerStore.getState()
      s.setEnabled(false)
      expect(s.isDeploymentAvailable("any::thing")).toBe(true)
    })

    it("forwards retryAfterMs into the breaker's dynamic cooldown", () => {
      const s = useCircuitBreakerStore.getState()
      s.setEnabled(true)
      s.recordFailure("p", { modelId: "m", retryAfterMs: 60_000 })
      s.recordFailure("p", { modelId: "m", retryAfterMs: 60_000 })
      const b = useCircuitBreakerStore.getState().breakers["p::m"]
      expect(b.state.state).toBe("open")
      expect(b.state.dynamicCooldownMs).toBe(60_000)
    })
  })
})
