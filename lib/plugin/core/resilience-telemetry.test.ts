import {
  __resetRegistryForTesting,
  getOrCreateBreaker,
  loadBreakerKey,
} from "@/lib/plugin/resilience/breaker-registry"
import {
  __resetResilienceTelemetryForTesting,
  getPluginResilienceSnapshot,
  getRecentActivationFailures,
  recordActivationFailure,
  recordLoadAttempt,
  recordLoadFailure,
  recordLoadRetry,
  recordLoadSuccess,
} from "@/lib/plugin/core/resilience-telemetry"

describe("resilience-telemetry", () => {
  beforeEach(() => {
    __resetResilienceTelemetryForTesting()
    __resetRegistryForTesting()
  })

  it("accumulates load attempts, retries and last success", () => {
    recordLoadAttempt("p")
    recordLoadRetry("p")
    recordLoadSuccess("p", 1000)
    const snap = getPluginResilienceSnapshot("p")
    expect(snap.load.attempts).toBe(1)
    expect(snap.load.retries).toBe(1)
    expect(snap.load.lastSuccessAt).toBe(1000)
    expect(snap.load.lastError).toBeNull()
  })

  it("records a load failure and clears it on a later success", () => {
    recordLoadFailure("p", new Error("boom"), 500)
    expect(getPluginResilienceSnapshot("p").load.lastError).toEqual({ message: "boom", at: 500 })
    recordLoadSuccess("p", 600)
    expect(getPluginResilienceSnapshot("p").load.lastError).toBeNull()
  })

  it("keeps activation failures (bounded) and exposes them globally + per-plugin", () => {
    recordActivationFailure("p", "onTool:x", new Error("nope"), 1)
    recordActivationFailure("other", "onCommand:y", new Error("bad"), 2)
    expect(getRecentActivationFailures()).toHaveLength(2)
    const snap = getPluginResilienceSnapshot("p")
    expect(snap.recentActivationFailures).toEqual([
      { pluginId: "p", event: "onTool:x", message: "nope", at: 1 },
    ])
  })

  it("joins breaker snapshots into the per-plugin snapshot", () => {
    getOrCreateBreaker(loadBreakerKey("p"), {
      failureThreshold: 3,
      cooldownMs: 1000,
      successThreshold: 1,
    })
    const snap = getPluginResilienceSnapshot("p")
    expect(snap.loadBreaker).not.toBeNull()
    expect(snap.loadBreaker?.state).toBe("closed")
    // No activation breaker created → null.
    expect(snap.activationBreaker).toBeNull()
  })

  it("returns an empty snapshot for an unknown plugin", () => {
    const snap = getPluginResilienceSnapshot("ghost")
    expect(snap).toEqual({
      pluginId: "ghost",
      load: { attempts: 0, retries: 0, lastError: null, lastSuccessAt: null },
      loadBreaker: null,
      activationBreaker: null,
      recentActivationFailures: [],
    })
  })

  it("caps the activation-failure buffer at 256", () => {
    for (let i = 0; i < 300; i++) {
      recordActivationFailure("p", "onTool:x", new Error(`e${i}`), i)
    }
    const all = getRecentActivationFailures()
    expect(all).toHaveLength(256)
    expect(all[all.length - 1].message).toBe("e299")
  })
})
