import {
  checkResilienceBudget,
  DEFAULT_PLUGIN_RESILIENCE,
  isRetryableLoadError,
  LOAD_RESILIENCE,
  resolveResilienceConfig,
  SIDECAR_IPC_TIMEOUT_MS,
} from "@/lib/plugin/resilience/config"

describe("resolveResilienceConfig", () => {
  it("applies defaults when nothing is configured", () => {
    expect(resolveResilienceConfig({})).toEqual(DEFAULT_PLUGIN_RESILIENCE)
  })

  it("lets the manifest override timeout and breaker thresholds", () => {
    const cfg = resolveResilienceConfig({
      resilience: { timeoutMs: 5000, breaker: { failureThreshold: 2, cooldownMs: 1000 } },
    })
    expect(cfg.timeoutMs).toBe(5000)
    expect(cfg.breaker.failureThreshold).toBe(2)
    expect(cfg.breaker.cooldownMs).toBe(1000)
    // unspecified breaker field keeps the default
    expect(cfg.breaker.successThreshold).toBe(DEFAULT_PLUGIN_RESILIENCE.breaker.successThreshold)
  })

  it("keeps retry off and clamps maxRetries to 0 by default", () => {
    const cfg = resolveResilienceConfig({ resilience: { maxRetries: 3 } })
    expect(cfg.retryable).toBe(false)
    expect(cfg.maxRetries).toBe(0)
  })

  it("honors manifest-level retryable opt-in", () => {
    const cfg = resolveResilienceConfig({ resilience: { retryable: true, maxRetries: 3 } })
    expect(cfg.retryable).toBe(true)
    expect(cfg.maxRetries).toBe(3)
  })

  it("lets a tool's retryable override the manifest (opt-in)", () => {
    const cfg = resolveResilienceConfig(
      { resilience: { retryable: false, maxRetries: 2 } },
      { retryable: true }
    )
    expect(cfg.retryable).toBe(true)
    // maxRetries comes from manifest now that retry is on
    expect(cfg.maxRetries).toBe(2)
  })

  it("lets a tool's retryable override the manifest (opt-out)", () => {
    const cfg = resolveResilienceConfig(
      { resilience: { retryable: true, maxRetries: 2 } },
      { retryable: false }
    )
    expect(cfg.retryable).toBe(false)
    expect(cfg.maxRetries).toBe(0)
  })

  it("resolves breakerScope", () => {
    expect(resolveResilienceConfig({ resilience: { breakerScope: "plugin" } }).breakerScope).toBe(
      "plugin"
    )
  })
})

describe("checkResilienceBudget", () => {
  it("returns null when the worst-case budget stays under the ceiling", () => {
    expect(checkResilienceBudget(resolveResilienceConfig({}))).toBeNull()
  })

  it("warns when timeout × attempts meets/exceeds the sidecar ceiling", () => {
    const cfg = resolveResilienceConfig({
      resilience: { retryable: true, timeoutMs: 60_000, maxRetries: 1 },
    })
    const warning = checkResilienceBudget(cfg)
    expect(warning).toContain(String(SIDECAR_IPC_TIMEOUT_MS))
  })
})

describe("isRetryableLoadError", () => {
  it("retries transient load failures (fetch/IPC)", () => {
    expect(isRetryableLoadError(new Error("Failed to fetch plugin: 503"))).toBe(true)
    expect(isRetryableLoadError(new Error("IPC channel closed"))).toBe(true)
  })

  it("does not retry permanent load failures", () => {
    expect(isRetryableLoadError(new Error("plugin does not export a valid definition"))).toBe(false)
    expect(isRetryableLoadError(new Error("Unknown plugin type: banana"))).toBe(false)
    expect(isRetryableLoadError(new Error("Signature verification failed"))).toBe(false)
    expect(isRetryableLoadError(new Error("Invalid plugin manifest: bad"))).toBe(false)
  })

  it("inherits the shared sentinel exclusions (4xx/validation)", () => {
    expect(isRetryableLoadError(new Error("404 not found"))).toBe(false)
  })

  it("exposes sane load defaults", () => {
    expect(LOAD_RESILIENCE.maxRetries).toBeGreaterThan(0)
    expect(LOAD_RESILIENCE.breaker.failureThreshold).toBeGreaterThan(0)
  })
})
