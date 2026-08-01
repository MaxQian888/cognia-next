import { resolveCrashCapabilities } from "./crash-capabilities"

describe("crash capability matrix", () => {
  it("reports full desktop capture only when the native probe is healthy", () => {
    const capabilities = resolveCrashCapabilities({
      platform: "windows",
      nativeMonitorHealthy: true,
      symbolUploadConfigured: false,
    })

    expect(capabilities.capabilities.nativeCrash).toEqual({ status: "supported" })
    expect(capabilities.capabilities.minidump).toEqual({ status: "supported" })
    expect(capabilities.capabilities.symbolication).toEqual({
      status: "degraded",
      reasonCode: "symbols.not_configured",
    })
  })

  it("exposes iOS native and MetricKit support without claiming Android APIs", () => {
    const capabilities = resolveCrashCapabilities({
      platform: "capacitor-ios",
      osVersion: 16,
      nativeMonitorHealthy: true,
      symbolUploadConfigured: true,
    })

    expect(capabilities.capabilities.nativeCrash.status).toBe("supported")
    expect(capabilities.capabilities.systemDiagnostics.status).toBe("supported")
    expect(capabilities.capabilities.anr).toEqual({
      status: "unsupported",
      reasonCode: "platform.not_applicable",
    })
  })

  it("degrades Android exit diagnostics below API 30 instead of hiding the gap", () => {
    const capabilities = resolveCrashCapabilities({
      platform: "capacitor-android",
      apiLevel: 29,
      nativeMonitorHealthy: true,
      symbolUploadConfigured: true,
    })

    expect(capabilities.capabilities.nativeCrash.status).toBe("supported")
    expect(capabilities.capabilities.systemDiagnostics).toEqual({
      status: "degraded",
      reasonCode: "android.application_exit_info_requires_api_30",
    })
    expect(capabilities.capabilities.anr).toEqual({
      status: "degraded",
      reasonCode: "android.watchdog_only",
    })
  })

  it("does not claim native artifacts in a browser", () => {
    const capabilities = resolveCrashCapabilities({ platform: "browser" })

    expect(capabilities.capabilities.javascriptCrash.status).toBe("supported")
    expect(capabilities.capabilities.nativeCrash.status).toBe("unsupported")
    expect(capabilities.capabilities.minidump.status).toBe("unsupported")
  })
})
