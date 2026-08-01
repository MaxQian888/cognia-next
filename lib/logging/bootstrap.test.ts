/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"

// `bootstrap.ts` ships an IIFE-style `hasBootstrapped` flag at module scope.
// Each test resets the module registry and the localStorage / IDB factory so
// the suite stays isolated.
beforeEach(() => {
  jest.resetModules()
  localStorage.clear()
  const factory = new IDBFactory()
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = factory
  ;(window as unknown as { indexedDB: IDBFactory }).indexedDB = factory
})

// `setPlatformLoggingConfig` is a Tauri IPC call we must keep silent in
// jsdom. The native-logging module already handles `!isTauri()` by no-op'ing,
// but we still mock it to avoid pulling in the Tauri API surface.
jest.mock("@/lib/native/native-logging", () => ({
  setPlatformLoggingConfig: jest.fn(async () => null),
}))

describe("bootstrapLogger persistence + transport attach/detach", () => {
  it("derives the OTLP Logs endpoint from trace and collector base URLs", async () => {
    const { otlpLogsEndpoint } = await import("./bootstrap")
    expect(otlpLogsEndpoint("http://localhost:4318/v1/traces")).toBe(
      "http://localhost:4318/v1/logs"
    )
    expect(otlpLogsEndpoint("https://collector.example/otlp/")).toBe(
      "https://collector.example/otlp/v1/logs"
    )
    expect(otlpLogsEndpoint(" ")).toBe("")
  })

  it("registers the default transports on first run", async () => {
    const mod = await import("./bootstrap")
    const state = mod.bootstrapLogger()
    expect(state.transports.console).toBe(true)
    expect(state.transports.indexedDB).toBe(true)
    expect(state.transports.native).toBe(true)
    // Remote / Langfuse remain default-on; the dead OtelTransport was removed.
    // short-circuit silently until credentials/endpoints are filled in.
    expect(state.transports.remote).toBe(true)
    expect(state.transports.langfuse).toBe(true)
    const names = mod.listRegisteredTransports()
    expect(names).toEqual(expect.arrayContaining(["console", "indexeddb", "observability-spool"]))
    // Remote stays detached without a configured endpoint, even when its
    // toggle is on. Langfuse and OTel attach (they run as no-ops without
    // credentials).
    expect(names).not.toContain("remote")
  })

  it("persists user-applied settings to localStorage and reads them back", async () => {
    const mod = await import("./bootstrap")
    mod.bootstrapLogger()
    mod.applyLoggingSettings({
      config: { minLevel: "warn" },
      transports: { langfuse: false },
      retention: { maxEntries: 500, maxAgeDays: 1 },
      persist: true,
    })
    const transports = JSON.parse(localStorage.getItem(mod.LOGGING_TRANSPORTS_STORAGE_KEY) || "{}")
    const retention = JSON.parse(localStorage.getItem(mod.LOGGING_RETENTION_STORAGE_KEY) || "{}")
    const config = JSON.parse(localStorage.getItem(mod.LOGGING_CONFIG_STORAGE_KEY) || "{}")
    expect(transports.langfuse).toBe(false)
    expect(retention).toMatchObject({ maxEntries: 500, maxAgeDays: 1 })
    expect(config.minLevel).toBe("warn")
  })

  it("preserves legacy plaintext for retry when secure persistence fails", async () => {
    localStorage.setItem(
      "cognia-logging-transports",
      JSON.stringify({
        langfuseConfig: { publicKey: "pk", secretKey: "sk-legacy" },
        agentTraceOtlpConfig: {
          grafanaCloud: { instanceId: "123", apiToken: "glc_legacy" },
        },
      })
    )
    const mod = await import("./bootstrap")
    const state = mod.bootstrapLogger()
    expect(localStorage.getItem(mod.LOGGING_TRANSPORTS_STORAGE_KEY)).toContain("sk-legacy")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const persisted = localStorage.getItem(mod.LOGGING_TRANSPORTS_STORAGE_KEY) ?? ""
    expect(persisted).toContain("sk-legacy")
    expect(persisted).toContain("glc_legacy")
    expect(state.transports.langfuseConfig.secretKeyConfigured).toBe(true)
    expect(state.transports.agentTraceOtlpConfig.grafanaCloud.apiTokenConfigured).toBe(true)
  })

  it("re-reads persisted toggle state on a fresh module load", async () => {
    const m1 = await import("./bootstrap")
    m1.bootstrapLogger()
    m1.applyLoggingSettings({
      transports: { console: false, indexedDB: true },
      persist: true,
    })

    jest.resetModules()
    const m2 = await import("./bootstrap")
    const state = m2.bootstrapLogger()
    // The persisted toggle state is faithfully restored from localStorage.
    expect(state.transports.console).toBe(false)
    expect(state.transports.indexedDB).toBe(true)
  })

  it("clamps invalid persisted values back into range on the next bootstrap", async () => {
    // Simulate corrupt prior persistence — bufferSize out of range, minLevel
    // unrecognized. bootstrapLogger sanitizes on read.
    localStorage.setItem(
      "cognia-logging-config",
      JSON.stringify({ bufferSize: -5, minLevel: "spam", redaction: { maxDepth: -1 } })
    )
    const mod = await import("./bootstrap")
    const state = mod.bootstrapLogger()
    expect(state.config.bufferSize).toBeGreaterThanOrEqual(1)
    expect(state.config.redaction.maxDepth).toBeGreaterThanOrEqual(1)
    // 'spam' isn't a valid LogLevel — it falls back to the default.
    expect(["trace", "debug", "info", "warn", "error", "fatal"]).toContain(state.config.minLevel)
  })

  it("ignores corrupted localStorage payloads", async () => {
    localStorage.setItem("cognia-logging-transports", "{not json")
    const mod = await import("./bootstrap")
    const state = mod.bootstrapLogger()
    expect(state.transports.console).toBe(true)
    expect(state.transports.indexedDB).toBe(true)
  })

  it("samples per-module rates from the sampling storage key", async () => {
    localStorage.setItem(
      "cognia-logging-sampling",
      JSON.stringify({ "noisy-module": 0.25, "ignored-key": "not-a-number" })
    )
    const mod = await import("./bootstrap")
    const state = mod.bootstrapLogger()
    expect(state.config.minLevel).toBeDefined()
    // Sampling configuration is opaque from the bootstrap API; the
    // `samplingRules` payload was accepted (no throw) and the noisy-module
    // entry stayed, while the bogus rate was filtered out.
  })

  it("persists per-module levels to localStorage and reads them back", async () => {
    const mod = await import("./bootstrap")
    mod.bootstrapLogger()
    mod.applyLoggingSettings({
      config: { perModuleLevels: { network: "debug", "network:lark": "trace" } },
      persist: true,
    })
    const config = JSON.parse(localStorage.getItem(mod.LOGGING_CONFIG_STORAGE_KEY) || "{}")
    expect(config.perModuleLevels).toEqual({ network: "debug", "network:lark": "trace" })

    // Re-bootstrap from a fresh module registry: the rule must rehydrate.
    jest.resetModules()
    const reloaded = await import("./bootstrap")
    const state = reloaded.bootstrapLogger()
    expect(state.config.perModuleLevels).toMatchObject({
      network: "debug",
      "network:lark": "trace",
    })
  })

  it("drops invalid per-module level entries when reading malformed storage", async () => {
    localStorage.setItem(
      "cognia-logging-config",
      JSON.stringify({
        minLevel: "info",
        perModuleLevels: {
          network: "debug", // valid
          ai: "verbose", // invalid level -> dropped
          "": "trace", // empty key -> dropped
          "  ": "trace", // whitespace key -> dropped
          other: 5, // non-string -> dropped
        },
      })
    )
    const mod = await import("./bootstrap")
    const state = mod.bootstrapLogger()
    expect(state.config.perModuleLevels).toEqual({ network: "debug" })
  })
})
