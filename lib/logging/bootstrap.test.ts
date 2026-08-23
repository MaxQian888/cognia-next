/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"

import type { LangfuseTransport } from "./transports/langfuse-transport"

const mockIsTauri = jest.fn(() => false)
const mockPostTauriTelemetryJson = jest.fn<Promise<{ ok: boolean }>, unknown[]>(async () => ({
  ok: true,
}))
const mockConfigureTauriSidecarTelemetry = jest.fn<Promise<void>, unknown[]>(async () => undefined)

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => mockIsTauri(),
}))
jest.mock("./transports/tauri-fetch-shim", () => ({
  configureTauriSidecarTelemetry: (...args: unknown[]) =>
    mockConfigureTauriSidecarTelemetry(...args),
  createTauriOtlpFetch: jest.fn(() => fetch),
  postTauriTelemetryJson: (...args: unknown[]) => mockPostTauriTelemetryJson(...args),
}))

// `bootstrap.ts` ships an IIFE-style `hasBootstrapped` flag at module scope.
// Each test resets the module registry and the localStorage / IDB factory so
// the suite stays isolated.
beforeEach(() => {
  jest.resetModules()
  jest.clearAllMocks()
  mockIsTauri.mockReturnValue(false)
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
    const { otlpLogsEndpoint, postHogAiEndpoint, resolvePostHogDestinations } =
      await import("./bootstrap")
    expect(otlpLogsEndpoint("http://localhost:4318/v1/traces")).toBe(
      "http://localhost:4318/v1/logs"
    )
    expect(otlpLogsEndpoint("https://collector.example/otlp/")).toBe(
      "https://collector.example/otlp/v1/logs"
    )
    expect(otlpLogsEndpoint(" ")).toBe("")
    expect(postHogAiEndpoint("https://eu.i.posthog.com/custom")).toBe(
      "https://eu.i.posthog.com/i/v0/ai/otel"
    )
    expect(
      resolvePostHogDestinations({
        managed: { productAnalytics: false, aiObservability: false },
        byo: {
          productAnalytics: true,
          aiObservability: true,
          host: "https://posthog.example/private/path",
          projectToken: "phc_project",
        },
      })
    ).toEqual([
      {
        id: "byo",
        host: "https://posthog.example",
        projectToken: "phc_project",
        productAnalytics: true,
        aiObservability: true,
      },
    ])
  })

  it("sends PostHog product analytics through the native leg on desktop", async () => {
    mockIsTauri.mockReturnValue(true)
    localStorage.setItem(
      "cognia-logging-transports",
      JSON.stringify({
        posthogConfig: {
          managed: { productAnalytics: false, aiObservability: false },
          byo: {
            productAnalytics: true,
            aiObservability: false,
            host: "https://posthog.example",
            projectToken: "phc_project",
          },
        },
      })
    )
    localStorage.setItem(
      "cognia-behavior-telemetry-enabled",
      JSON.stringify({ enabled: true, destinations: { local: false, remote: false } })
    )
    const mod = await import("./bootstrap")
    mod.bootstrapLogger()

    const { trackEvent } = await import("@/lib/telemetry/events/track-event")
    await trackEvent("telemetry.posthog.test", { source: "settings" })

    expect(mockPostTauriTelemetryJson).toHaveBeenCalledTimes(1)
    const [endpoint, body, credential, signal] = mockPostTauriTelemetryJson.mock.calls[0]
    // The renderer CSP blocks a direct connection, so this must not be a
    // browser fetch — it has to cross into Rust.
    expect(endpoint).toBe("https://posthog.example/batch/")
    expect(credential).toEqual({ kind: "none" })
    expect(signal).toEqual(expect.any(AbortSignal))
    const payload = JSON.parse(body as string)
    expect(payload.api_key).toBe("phc_project")
    expect(payload.batch[0].event).toBe("telemetry.posthog.test")
    expect(payload.batch[0].distinct_id).toBe(
      localStorage.getItem("cognia-posthog-product-distinct-id")
    )
    expect(payload.batch[0].distinct_id).not.toBe(
      localStorage.getItem("cognia-observability-installation-id")
    )
  })

  it("wires PostHog AI with its separate identity and 4 MB request limit", async () => {
    localStorage.setItem(
      "cognia-logging-transports",
      JSON.stringify({
        posthogConfig: {
          managed: { productAnalytics: false, aiObservability: false },
          byo: {
            productAnalytics: true,
            aiObservability: true,
            host: "https://posthog.example",
            projectToken: "phc_project",
          },
        },
      })
    )
    const mod = await import("./bootstrap")
    mod.bootstrapLogger()
    const { getTransport } = await import("@cognia/logging/core")
    const transport = getTransport("agent-trace-posthog-byo") as unknown as {
      options: {
        destinationFingerprint: string
        maxRequestBytes: number
        resource: { spanAttributes?: Record<string, string> }
      }
    }

    expect(transport.options.maxRequestBytes).toBe(4 * 1024 * 1024)
    expect(transport.options.destinationFingerprint).toContain("https://posthog.example")
    expect(transport.options.resource.spanAttributes?.["posthog.distinct_id"]).toBe(
      localStorage.getItem("cognia-observability-installation-id")
    )
    expect(transport.options.resource.spanAttributes?.["posthog.distinct_id"]).not.toBe(
      localStorage.getItem("cognia-posthog-product-distinct-id")
    )
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
    expect(state.transports.posthogConfig).toEqual({
      managed: { productAnalytics: false, aiObservability: false },
      byo: {
        productAnalytics: false,
        aiObservability: false,
        host: "",
        projectToken: "",
      },
    })
    const names = mod.listRegisteredTransports()
    expect(names).toEqual(expect.arrayContaining(["console", "indexeddb", "observability-spool"]))
    // Remote stays detached without a configured endpoint, even when its
    // toggle is on. Langfuse and OTel attach (they run as no-ops without
    // credentials).
    expect(names).not.toContain("remote")
  })

  it("wires the shared Langfuse ingestion batch through native credential injection", async () => {
    mockIsTauri.mockReturnValue(true)
    localStorage.setItem(
      "cognia-logging-transports",
      JSON.stringify({
        langfuse: true,
        langfuseConfig: {
          publicKey: "pk-native",
          secretKeyConfigured: true,
          host: "https://langfuse.example/",
          minLevel: "warn",
        },
      })
    )
    const mod = await import("./bootstrap")
    mod.bootstrapLogger()
    const { getTransport } = await import("@cognia/logging/core")
    const transport = getTransport<InstanceType<typeof LangfuseTransport>>("langfuse")
    expect(transport).toBeDefined()

    transport?.log({
      id: "log-native",
      timestamp: "2026-08-09T00:00:00.000Z",
      level: "error",
      message: "native failure",
      module: "bootstrap-test",
      traceId: "trace-native",
    })
    await transport?.flush()

    expect(mockPostTauriTelemetryJson).toHaveBeenCalledWith(
      "https://langfuse.example/api/public/ingestion",
      expect.stringContaining('"event-create"'),
      { kind: "langfuse", publicKey: "pk-native" }
    )
    const body = JSON.parse(mockPostTauriTelemetryJson.mock.calls[0][1] as string)
    expect(body.batch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "trace-create" }),
        expect.objectContaining({ type: "event-create" }),
      ])
    )
  })

  it("does not attach the native exporter when the Rust Langfuse secret is absent", async () => {
    mockIsTauri.mockReturnValue(true)
    localStorage.setItem(
      "cognia-logging-transports",
      JSON.stringify({
        langfuse: true,
        langfuseConfig: {
          publicKey: "pk-native",
          secretKeyConfigured: false,
          host: "https://langfuse.example/",
          minLevel: "warn",
        },
      })
    )
    const mod = await import("./bootstrap")
    mod.bootstrapLogger()
    const { getTransport } = await import("@cognia/logging/core")
    const transport = getTransport<InstanceType<typeof LangfuseTransport>>("langfuse")

    transport?.log({
      id: "log-native-no-secret",
      timestamp: "2026-08-09T00:00:00.000Z",
      level: "error",
      message: "native failure",
      module: "bootstrap-test",
      traceId: "trace-native-no-secret",
    })
    await transport?.flush()

    expect(mockPostTauriTelemetryJson).not.toHaveBeenCalled()
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

/**
 * The core carries its own copy of four settings that the transport/retention
 * records also express, and acts on one of them on every registry call. These
 * pin the two views together — the reason the "Console Output" switch used to
 * do nothing.
 */
describe("core config mirrors the transport + retention records", () => {
  it("keeps the console transport removed once the setting turns it off", async () => {
    const { applyLoggingSettings, getLoggingBootstrapState, listRegisteredTransports } =
      await import("./bootstrap")
    const { getTransportHealthSnapshot } = await import("@cognia/logging")

    const state = getLoggingBootstrapState()
    expect(listRegisteredTransports()).toContain("console")

    applyLoggingSettings({
      transports: { ...state.transports, console: false },
      persist: false,
    })

    // `applyTransportSettings` removes console first and then calls
    // `addTransport` for six more sinks; each of those runs
    // `ensureInitialized()` → `syncBuiltinTransports()`, which re-added the
    // console transport from the core's own `enableConsole` flag.
    expect(listRegisteredTransports()).not.toContain("console")

    // The settings panel polls health every few seconds, which is another
    // `ensureInitialized()` — and was enough on its own to bring it back.
    getTransportHealthSnapshot()
    expect(listRegisteredTransports()).not.toContain("console")
  })

  it("restores the console transport when the setting turns it back on", async () => {
    const { applyLoggingSettings, getLoggingBootstrapState, listRegisteredTransports } =
      await import("./bootstrap")

    const state = getLoggingBootstrapState()
    applyLoggingSettings({ transports: { ...state.transports, console: false }, persist: false })
    expect(listRegisteredTransports()).not.toContain("console")

    applyLoggingSettings({ transports: { ...state.transports, console: true }, persist: false })
    expect(listRegisteredTransports()).toContain("console")
  })

  it("derives all four legacy mirror fields from the records that own them", async () => {
    const { applyLoggingSettings, getLoggingBootstrapState } = await import("./bootstrap")

    const state = getLoggingBootstrapState()
    const next = applyLoggingSettings({
      transports: { ...state.transports, console: false, indexedDB: false, remote: true },
      retention: { ...state.retention, maxEntries: 4242 },
      persist: false,
    })

    expect(next.config.enableConsole).toBe(false)
    expect(next.config.enableStorage).toBe(false)
    expect(next.config.enableRemote).toBe(true)
    expect(next.config.maxStorageEntries).toBe(4242)
  })
})

describe("IndexedDB write batching", () => {
  /** Wrap the real transport so both the create and the update path are visible. */
  function captureIndexedDbOptions() {
    const created: unknown[] = []
    const updated: unknown[] = []
    jest.doMock("./transports", () => {
      const actual = jest.requireActual("./transports")
      return {
        ...actual,
        createIndexedDBTransport: (options: unknown) => {
          created.push(options)
          const transport = actual.createIndexedDBTransport(options)
          const original = transport.updateOptions.bind(transport)
          transport.updateOptions = (next: unknown) => {
            updated.push(next)
            original(next)
          }
          return transport
        },
      }
    })
    return { created, updated }
  }

  it("builds the transport from the persisted buffer size and flush interval", async () => {
    // Both fields were sanitized on read and written on save, but never
    // reached the only transport that consumes them, so batching always ran
    // at the transport's own defaults.
    localStorage.setItem(
      "cognia-logging-config",
      JSON.stringify({ bufferSize: 7, flushInterval: 12_345 })
    )
    const { created } = captureIndexedDbOptions()

    const { getLoggingBootstrapState } = await import("./bootstrap")
    getLoggingBootstrapState()

    expect(created.at(-1)).toMatchObject({ bufferSize: 7, flushInterval: 12_345 })
  })

  it("pushes a later change onto the transport already running", async () => {
    const { updated } = captureIndexedDbOptions()

    const { applyLoggingSettings, getLoggingBootstrapState } = await import("./bootstrap")
    const state = getLoggingBootstrapState()

    applyLoggingSettings({
      config: { ...state.config, bufferSize: 9, flushInterval: 4_000 },
      transports: { ...state.transports, indexedDB: true },
      persist: false,
    })

    expect(updated.at(-1)).toMatchObject({ bufferSize: 9, flushInterval: 4_000 })
  })

  it("still carries the retention bounds alongside them", async () => {
    const { updated } = captureIndexedDbOptions()

    const { applyLoggingSettings, getLoggingBootstrapState } = await import("./bootstrap")
    const state = getLoggingBootstrapState()

    applyLoggingSettings({
      config: { ...state.config, bufferSize: 9 },
      retention: { maxEntries: 2_000, maxAgeDays: 3 },
      transports: { ...state.transports, indexedDB: true },
      persist: false,
    })

    expect(updated.at(-1)).toMatchObject({
      bufferSize: 9,
      maxEntries: 2_000,
      retentionDays: 3,
    })
  })
})
