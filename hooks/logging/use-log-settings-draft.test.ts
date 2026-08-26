/**
 * Draft-state coverage for the logs settings section.
 *
 * Two of these tests exist because the pre-redesign panel got them wrong:
 *
 * - `loadSamplingRules()` seeded five rules the runtime had never applied, so
 *   the UI displayed sampling that was not happening.
 * - `reset()` restored a hand-copied set of defaults that had drifted from the
 *   ones bootstrap actually ships (remote/Langfuse off vs on, and four config
 *   fields).
 *
 * Both are pinned against the exported `DEFAULT_*` records rather than literals
 * so the assertions cannot drift the same way a second time.
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import {
  DEFAULT_RETENTION_SETTINGS,
  DEFAULT_TRANSPORT_SETTINGS,
  LOGGING_SAMPLING_STORAGE_KEY,
  RECOMMENDED_SAMPLING_RATES,
} from "@/lib/logging"
import { DEFAULT_UNIFIED_CONFIG } from "@/types/logging"

import {
  RECOMMENDED_SAMPLING_RULES,
  countChangedFields,
  factoryDraft,
  loadSamplingRules,
  persistSamplingRules,
  useLogSettingsDraft,
} from "./use-log-settings-draft"

const applyLoggingSettings = jest.fn()
const configureSampling = jest.fn()
const getLangfuseCredentialsStatus = jest.fn(async () => {
  throw new Error("Host unavailable")
})
const testLangfuseConnection = jest.fn(async () => ({ connected: true, status: 200 }))

jest.mock("@/lib/logging/langfuse-host", () => ({
  clearLangfuseCredentials: jest.fn(async () => undefined),
  setLangfuseCredentials: jest.fn(async () => undefined),
  getLangfuseCredentialsStatus: () => getLangfuseCredentialsStatus(),
  testLangfuseConnection: () => testLangfuseConnection(),
}))

jest.mock("@/lib/logging", () => {
  const actual = jest.requireActual("@/lib/logging")
  return {
    ...actual,
    applyLoggingSettings: (...args: unknown[]) => applyLoggingSettings(...args),
    configureSampling: (...args: unknown[]) => configureSampling(...args),
  }
})

const saveAppSettings = jest.fn(async () => undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { save: typeof saveAppSettings }) => unknown) =>
    selector({ save: saveAppSettings }),
}))

// Partial mock: `lib/logging/bootstrap.ts` also imports
// `configureBehaviorEventExporters` from this module, and replacing the whole
// module breaks the logger bootstrap the hook calls on mount.
jest.mock("@/lib/telemetry/events/track-event", () => ({
  ...jest.requireActual("@/lib/telemetry/events/track-event"),
  trackEvent: jest.fn(async () => true),
}))

beforeEach(() => {
  window.localStorage.clear()
  applyLoggingSettings.mockReset()
  configureSampling.mockReset()
  getLangfuseCredentialsStatus.mockClear()
  testLangfuseConnection.mockClear()
  saveAppSettings.mockClear()
  // `applyLoggingSettings` returns the settled state the hook re-seeds from.
  applyLoggingSettings.mockImplementation(
    (params: { config?: object; transports?: object; retention?: object }) => ({
      config: { ...DEFAULT_UNIFIED_CONFIG, ...(params.config ?? {}) },
      transports: { ...DEFAULT_TRANSPORT_SETTINGS, ...(params.transports ?? {}) },
      retention: { ...DEFAULT_RETENTION_SETTINGS, ...(params.retention ?? {}) },
    })
  )
})

describe("loadSamplingRules", () => {
  it("returns nothing when no sampling is configured", () => {
    // The runtime configures no sampling for an empty map; showing rules here
    // would be the panel claiming a filter that is not applied.
    expect(loadSamplingRules()).toEqual([])
  })

  it("returns nothing for unparseable storage", () => {
    window.localStorage.setItem(LOGGING_SAMPLING_STORAGE_KEY, "{not json")
    expect(loadSamplingRules()).toEqual([])
  })

  it("converts stored 0..1 rates to whole percentages", () => {
    window.localStorage.setItem(
      LOGGING_SAMPLING_STORAGE_KEY,
      JSON.stringify({ mouse: 0.01, error: 1 })
    )
    expect(loadSamplingRules()).toEqual([
      { modulePrefix: "mouse", percentage: 1 },
      { modulePrefix: "error", percentage: 100 },
    ])
  })

  it("drops blank prefixes and non-numeric rates", () => {
    window.localStorage.setItem(
      LOGGING_SAMPLING_STORAGE_KEY,
      JSON.stringify({ "  ": 0.5, mouse: "half", scroll: 0.05 })
    )
    expect(loadSamplingRules()).toEqual([{ modulePrefix: "scroll", percentage: 5 }])
  })
})

describe("persistSamplingRules", () => {
  it("writes 0..1 rates and configures the runtime with the same map", () => {
    persistSamplingRules([{ modulePrefix: " mouse ", percentage: 1 }])

    expect(JSON.parse(window.localStorage.getItem(LOGGING_SAMPLING_STORAGE_KEY) ?? "{}")).toEqual({
      mouse: 0.01,
    })
    expect(configureSampling).toHaveBeenCalledWith({ mouse: { rate: 0.01 } })
  })

  it("skips blank prefixes", () => {
    persistSamplingRules([{ modulePrefix: "   ", percentage: 50 }])
    expect(JSON.parse(window.localStorage.getItem(LOGGING_SAMPLING_STORAGE_KEY) ?? "{}")).toEqual(
      {}
    )
  })
})

describe("RECOMMENDED_SAMPLING_RULES", () => {
  it("mirrors the exported rates as sorted percentages", () => {
    expect(RECOMMENDED_SAMPLING_RULES).toEqual(
      Object.entries(RECOMMENDED_SAMPLING_RATES)
        .map(([modulePrefix, rate]) => ({ modulePrefix, percentage: Math.round(rate * 100) }))
        .sort((left, right) => left.modulePrefix.localeCompare(right.modulePrefix))
    )
  })
})

describe("factoryDraft", () => {
  it("takes its values from the records bootstrap reads, not a second copy", () => {
    const factory = factoryDraft()

    // The exact drift the old inline reset had: these ship enabled so the
    // health badge reads "degraded" until they are configured.
    expect(factory.transports.remote).toBe(DEFAULT_TRANSPORT_SETTINGS.remote)
    expect(factory.transports.langfuse).toBe(DEFAULT_TRANSPORT_SETTINGS.langfuse)
    expect(factory.config.minLevel).toBe(DEFAULT_UNIFIED_CONFIG.minLevel)
    expect(factory.config.includeSource).toBe(DEFAULT_UNIFIED_CONFIG.includeSource)
    expect(factory.config.bufferSize).toBe(DEFAULT_UNIFIED_CONFIG.bufferSize)
    expect(factory.config.flushInterval).toBe(DEFAULT_UNIFIED_CONFIG.flushInterval)
    expect(factory.retention).toEqual(DEFAULT_RETENTION_SETTINGS)
    expect(factory.samplingRules).toEqual([])
  })

  it("hands out copies, so editing a draft cannot mutate the shipped defaults", () => {
    const first = factoryDraft()
    first.transports.nativeConfig.batchSize = 99
    first.retention.maxEntries = 1

    expect(factoryDraft().transports.nativeConfig.batchSize).toBe(
      DEFAULT_TRANSPORT_SETTINGS.nativeConfig.batchSize
    )
    expect(factoryDraft().retention.maxEntries).toBe(DEFAULT_RETENTION_SETTINGS.maxEntries)
  })
})

describe("countChangedFields", () => {
  it("is zero for an unchanged draft", () => {
    expect(countChangedFields(factoryDraft(), factoryDraft())).toBe(0)
  })

  it("counts each changed field once", () => {
    const next = factoryDraft()
    next.config.minLevel = "error"
    next.retention.maxAgeDays = 30
    expect(countChangedFields(factoryDraft(), next)).toBe(2)
  })

  it("ignores per-module override ordering", () => {
    const baseline = factoryDraft()
    baseline.config.perModuleLevels = { a: "warn", b: "debug" }
    const next = factoryDraft()
    next.config.perModuleLevels = { b: "debug", a: "warn" }
    expect(countChangedFields(baseline, next)).toBe(0)
  })

  it("ignores sampling-rule ordering", () => {
    const baseline = factoryDraft()
    baseline.samplingRules = [
      { modulePrefix: "mouse", percentage: 1 },
      { modulePrefix: "error", percentage: 100 },
    ]
    const next = factoryDraft()
    next.samplingRules = [
      { modulePrefix: "error", percentage: 100 },
      { modulePrefix: "mouse", percentage: 1 },
    ]
    expect(countChangedFields(baseline, next)).toBe(0)
  })
})

describe("useLogSettingsDraft", () => {
  it("starts clean with nothing to save", () => {
    const { result } = renderHook(() => useLogSettingsDraft())
    expect(result.current.status).toBe("clean")
    expect(result.current.changedCount).toBe(0)
    expect(result.current.saveError).toBe(false)
  })

  it("goes dirty with a running count as fields change", () => {
    const { result } = renderHook(() => useLogSettingsDraft())

    act(() => result.current.setConfig("minLevel", "error"))
    expect(result.current.status).toBe("dirty")
    expect(result.current.changedCount).toBe(1)

    act(() => result.current.setRetention("maxAgeDays", 21))
    expect(result.current.changedCount).toBe(2)
  })

  it("returns to clean when a field is edited back to its saved value", () => {
    const { result } = renderHook(() => useLogSettingsDraft())
    const original = result.current.config.minLevel

    act(() => result.current.setConfig("minLevel", "fatal"))
    expect(result.current.changedCount).toBe(1)

    act(() => result.current.setConfig("minLevel", original))
    expect(result.current.status).toBe("clean")
  })

  it("counts the IndexedDB batching knobs, which the transport now consumes", () => {
    const { result } = renderHook(() => useLogSettingsDraft())

    act(() => result.current.setConfig("bufferSize", 7))
    expect(result.current.changedCount).toBe(1)

    act(() => result.current.setConfig("flushInterval", 4000))
    expect(result.current.changedCount).toBe(2)
  })

  it("carries the batching knobs into the applied config", async () => {
    const { result } = renderHook(() => useLogSettingsDraft())

    act(() => {
      result.current.setConfig("bufferSize", 7)
      result.current.setConfig("flushInterval", 4000)
    })
    await act(async () => {
      await result.current.save()
    })

    const payload = applyLoggingSettings.mock.calls[0][0] as {
      config: { bufferSize: number; flushInterval: number }
    }
    expect(payload.config).toMatchObject({ bufferSize: 7, flushInterval: 4000 })
  })

  it("counts a typed secret as pending work even though it is write-only", () => {
    const { result } = renderHook(() => useLogSettingsDraft())
    act(() => result.current.setSecretDraft("langfuseSecretKey", "sk-live-abc"))
    expect(result.current.changedCount).toBe(1)
    expect(result.current.status).toBe("dirty")
  })

  it("ignores an empty per-module prefix", () => {
    const { result } = renderHook(() => useLogSettingsDraft())
    act(() => result.current.setModuleLevel("   ", "debug"))
    expect(result.current.config.perModuleLevels).toEqual({})
    expect(result.current.status).toBe("clean")
  })

  it("adds and removes per-module overrides", () => {
    const { result } = renderHook(() => useLogSettingsDraft())

    act(() => result.current.setModuleLevel("network:lark", "trace"))
    expect(result.current.config.perModuleLevels).toEqual({ "network:lark": "trace" })

    act(() => result.current.removeModuleLevel("network:lark"))
    expect(result.current.config.perModuleLevels).toEqual({})
  })

  it("keeps managed and BYO PostHog consent independent", () => {
    const { result } = renderHook(() => useLogSettingsDraft())

    act(() => result.current.setPostHog("byo", "productAnalytics", true))

    expect(result.current.transports.posthogConfig.byo.productAnalytics).toBe(true)
    expect(result.current.transports.posthogConfig.byo.aiObservability).toBe(false)
    expect(result.current.transports.posthogConfig.managed.productAnalytics).toBe(false)
  })

  it("reset loads the shipped defaults into the draft without saving them", () => {
    const { result } = renderHook(() => useLogSettingsDraft())

    act(() => result.current.reset())

    expect(result.current.transports.remote).toBe(DEFAULT_TRANSPORT_SETTINGS.remote)
    expect(result.current.transports.langfuse).toBe(DEFAULT_TRANSPORT_SETTINGS.langfuse)
    expect(result.current.config.minLevel).toBe(DEFAULT_UNIFIED_CONFIG.minLevel)
    expect(result.current.samplingRules).toEqual([])
    expect(applyLoggingSettings).not.toHaveBeenCalled()
  })

  it("discard reverts every field to the last saved values", () => {
    const { result } = renderHook(() => useLogSettingsDraft())
    const originalLevel = result.current.config.minLevel

    act(() => {
      result.current.setConfig("minLevel", "fatal")
      result.current.setRetention("maxEntries", 42000)
      result.current.setSecretDraft("grafanaCloudApiToken", "glc_abc")
    })
    expect(result.current.changedCount).toBeGreaterThan(0)

    act(() => result.current.discard())

    expect(result.current.config.minLevel).toBe(originalLevel)
    expect(result.current.secretDrafts.grafanaCloudApiToken).toBe("")
    expect(result.current.status).toBe("clean")
  })

  it("save commits through applyLoggingSettings and clears the dirty state", async () => {
    const { result } = renderHook(() => useLogSettingsDraft())

    act(() => result.current.setConfig("minLevel", "error"))
    await act(async () => {
      await result.current.save()
    })

    expect(applyLoggingSettings).toHaveBeenCalledTimes(1)
    const payload = applyLoggingSettings.mock.calls[0][0] as {
      config: { minLevel: string; remoteEndpoint: string }
      persist: boolean
    }
    expect(payload.config.minLevel).toBe("error")
    expect(payload.persist).toBe(true)
    expect(result.current.changedCount).toBe(0)
  })

  it("save persists the sampling rules alongside the rest of the draft", async () => {
    const { result } = renderHook(() => useLogSettingsDraft())

    act(() => result.current.setSamplingRules([{ modulePrefix: "mouse", percentage: 1 }]))
    await act(async () => {
      await result.current.save()
    })

    expect(configureSampling).toHaveBeenCalledWith({ mouse: { rate: 0.01 } })
    expect(JSON.parse(window.localStorage.getItem(LOGGING_SAMPLING_STORAGE_KEY) ?? "{}")).toEqual({
      mouse: 0.01,
    })
  })

  it("save mirrors the remote endpoint into the logger config", async () => {
    const { result } = renderHook(() => useLogSettingsDraft())

    act(() =>
      result.current.setTransportDetail("remoteConfig", "endpoint", "https://logs.example.com")
    )
    await act(async () => {
      await result.current.save()
    })

    const payload = applyLoggingSettings.mock.calls[0][0] as {
      config: { remoteEndpoint: string }
    }
    expect(payload.config.remoteEndpoint).toBe("https://logs.example.com")
  })

  it("hydrates Langfuse from the current account Host and tests its connection", async () => {
    getLangfuseCredentialsStatus.mockResolvedValueOnce({
      configured: true,
      enabled: true,
      baseUrl: "https://langfuse.example",
      publicKey: "pk-account",
      environment: "staging",
      captureModelContent: true,
      captureToolContent: false,
    })
    const { result } = renderHook(() => useLogSettingsDraft())

    await waitFor(() => expect(result.current.transports.langfuse).toBe(true))
    expect(result.current.transports.langfuseConfig).toMatchObject({
      secretKeyConfigured: true,
      publicKey: "pk-account",
      environment: "staging",
      captureModelContent: true,
      captureToolContent: false,
    })

    await act(async () => {
      await result.current.testLangfuseConnection()
    })
    expect(testLangfuseConnection).toHaveBeenCalledTimes(1)
    expect(result.current.langfuseConnectionStatus).toBe("connected")
  })

  it("surfaces a failed save instead of silently staying dirty", async () => {
    applyLoggingSettings.mockImplementation(() => {
      throw new Error("boom")
    })
    const { result } = renderHook(() => useLogSettingsDraft())

    act(() => result.current.setConfig("minLevel", "error"))
    await act(async () => {
      await result.current.save()
    })

    expect(result.current.saveError).toBe(true)
    expect(result.current.status).toBe("dirty")
  })
})
