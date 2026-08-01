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

  // ADR-0102's recovery policy is a pure module with no runtime consumer yet.
  // Until something persists its state and boots the diagnostics-first shell,
  // "this platform could host safe mode" must not read as "safe mode works".
  it.each(["macos", "windows", "linux", "capacitor-ios", "capacitor-android"] as const)(
    "reports safe mode as degraded on %s while the runtime is unwired",
    (platform) => {
      const capabilities = resolveCrashCapabilities({ platform, nativeMonitorHealthy: true })

      expect(capabilities.capabilities.safeMode).toEqual({
        status: "degraded",
        reasonCode: "safe_mode.runtime_not_wired",
      })
    }
  )

  it("reports safe mode as supported once a host declares the runtime wired", () => {
    const capabilities = resolveCrashCapabilities({
      platform: "macos",
      nativeMonitorHealthy: true,
      safeModeRuntimeAvailable: true,
    })

    expect(capabilities.capabilities.safeMode).toEqual({ status: "supported" })
  })

  it("keeps safe mode unsupported in a browser even when a host claims otherwise", () => {
    // No process to restart into: the flag cannot conjure a shell that the
    // platform has no way to boot.
    const capabilities = resolveCrashCapabilities({
      platform: "browser",
      safeModeRuntimeAvailable: true,
    })

    expect(capabilities.capabilities.safeMode).toEqual({
      status: "unsupported",
      reasonCode: "browser.safe_mode_unavailable",
    })
  })

  it("keeps safe mode not-applicable on non-desktop hosts", () => {
    for (const platform of ["server", "sidecar", "cli"] as const) {
      expect(resolveCrashCapabilities({ platform }).capabilities.safeMode).toEqual({
        status: "unsupported",
        reasonCode: "platform.not_applicable",
      })
    }
  })
})
