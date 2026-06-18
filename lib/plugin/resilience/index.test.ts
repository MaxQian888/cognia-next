import * as resilience from "@/lib/plugin/resilience"

describe("resilience barrel", () => {
  it("re-exports the public surface", () => {
    expect(typeof resilience.classifyResilienceError).toBe("function")
    expect(typeof resilience.runResilient).toBe("function")
    expect(typeof resilience.getOrCreateBreaker).toBe("function")
    expect(typeof resilience.resetPluginBreakers).toBe("function")
    expect(typeof resilience.resolveResilienceConfig).toBe("function")
    expect(typeof resilience.checkResilienceBudget).toBe("function")
    expect(typeof resilience.isRetryableLoadError).toBe("function")
    expect(resilience.CircuitOpenError).toBeDefined()
    expect(resilience.DEFAULT_PLUGIN_RESILIENCE).toBeDefined()
    expect(resilience.LOAD_RESILIENCE).toBeDefined()
    expect(resilience.SIDECAR_IPC_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
