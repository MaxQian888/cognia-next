import {
  checkResilienceBudget,
  DEFAULT_PLUGIN_RESILIENCE,
  isRetryableLoadError,
  LOAD_RESILIENCE,
  MAX_TOOL_TIMEOUT_MS,
  resolveResilienceConfig,
  SIDECAR_IPC_TIMEOUT_MS,
  TOOL_TIMEOUT_SLACK_MS,
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

  it("raises the timeout floor to a tool's declared budget plus slack", () => {
    // A cliTool's timeoutMs is the child-process kill; the resilience timer
    // must outlive it or the tool's own timeout error can never win.
    const cfg = resolveResilienceConfig({}, { timeoutMs: 60_000 })
    expect(cfg.timeoutMs).toBe(60_000 + 15_000)
    // A manifest resilience.timeoutMs stays the explicit backstop override.
    expect(
      resolveResilienceConfig({ resilience: { timeoutMs: 90_000 } }, { timeoutMs: 60_000 })
        .timeoutMs
    ).toBe(90_000)
    // Non-positive / absent tool budgets fall back to the default.
    expect(resolveResilienceConfig({}, { timeoutMs: 0 }).timeoutMs).toBe(
      DEFAULT_PLUGIN_RESILIENCE.timeoutMs
    )
    expect(resolveResilienceConfig({}, {}).timeoutMs).toBe(DEFAULT_PLUGIN_RESILIENCE.timeoutMs)
  })

  it("clamps an unvalidated imperative timeoutMs at the 600s child ceiling", () => {
    // cliTools manifests reject timeoutMs > 600_000 at validation; an
    // imperative registerTool def skips that path, so the floor clamps
    // instead of letting a huge value inflate the resilience/relay budgets.
    const cfg = resolveResilienceConfig({}, { timeoutMs: 3_600_000 })
    expect(cfg.timeoutMs).toBe(MAX_TOOL_TIMEOUT_MS + TOOL_TIMEOUT_SLACK_MS)
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
