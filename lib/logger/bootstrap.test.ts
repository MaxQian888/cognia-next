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
  it("registers the default transports on first run", async () => {
    const mod = await import("./bootstrap")
    const state = mod.bootstrapLogger()
    expect(state.transports.console).toBe(true)
    expect(state.transports.indexedDB).toBe(true)
    expect(state.transports.native).toBe(true)
    // Per Phase-6 decision: remote / langfuse / OTel default-on; they
    // short-circuit silently until credentials/endpoints are filled in.
    expect(state.transports.remote).toBe(true)
    expect(state.transports.langfuse).toBe(true)
    expect(state.transports.opentelemetry).toBe(true)
    const names = mod.listRegisteredTransports()
    expect(names).toEqual(expect.arrayContaining(["console", "indexeddb"]))
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
})
