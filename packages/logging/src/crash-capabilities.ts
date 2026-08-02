export type CrashPlatform =
  | "browser"
  | "server"
  | "windows"
  | "macos"
  | "linux"
  | "sidecar"
  | "cli"
  | "capacitor-ios"
  | "capacitor-android"

export type CrashCapabilityStatus = "supported" | "degraded" | "unsupported"

export interface CrashCapabilityState {
  status: CrashCapabilityStatus
  reasonCode?: string
}

export interface CrashCapabilityMatrix {
  platform: CrashPlatform
  checkedAt: string
  capabilities: {
    javascriptCrash: CrashCapabilityState
    nativeCrash: CrashCapabilityState
    minidump: CrashCapabilityState
    systemDiagnostics: CrashCapabilityState
    anr: CrashCapabilityState
    safeMode: CrashCapabilityState
    symbolication: CrashCapabilityState
  }
}

export interface CrashCapabilityProbe {
  platform: CrashPlatform
  checkedAt?: Date
  nativeMonitorHealthy?: boolean
  symbolUploadConfigured?: boolean
  osVersion?: number
  apiLevel?: number
  /**
   * Whether the ADR-0102 safe-mode runtime is actually wired on this host —
   * i.e. `recovery-policy` state is persisted across launches and a
   * diagnostics-first shell exists to boot into.
   *
   * Defaults to `false` because today nothing calls the policy: it is a pure
   * module with tests and no consumer. A platform that *could* host safe mode
   * is not a platform that *has* it, and reporting `supported` here told
   * operators a recovery path existed that would never trigger.
   */
  safeModeRuntimeAvailable?: boolean
}

const SUPPORTED: CrashCapabilityState = { status: "supported" }

/**
 * Safe mode on a platform that can host it. `degraded` — not `supported` —
 * until the runtime is wired, so the matrix never over-promises a recovery
 * path.
 */
function safeModeState(probe: CrashCapabilityProbe): CrashCapabilityState {
  return probe.safeModeRuntimeAvailable === true
    ? SUPPORTED
    : degraded("safe_mode.runtime_not_wired")
}

function unsupported(reasonCode: string): CrashCapabilityState {
  return { status: "unsupported", reasonCode }
}

function degraded(reasonCode: string): CrashCapabilityState {
  return { status: "degraded", reasonCode }
}

export function resolveCrashCapabilities(probe: CrashCapabilityProbe): CrashCapabilityMatrix {
  const nativeHealthy = probe.nativeMonitorHealthy === true
  const symbols = probe.symbolUploadConfigured ? SUPPORTED : degraded("symbols.not_configured")
  const notApplicable = unsupported("platform.not_applicable")

  if (probe.platform === "browser") {
    return {
      platform: probe.platform,
      checkedAt: (probe.checkedAt ?? new Date()).toISOString(),
      capabilities: {
        javascriptCrash: SUPPORTED,
        nativeCrash: unsupported("browser.native_capture_unavailable"),
        minidump: unsupported("browser.minidump_unavailable"),
        systemDiagnostics: unsupported("browser.system_diagnostics_unavailable"),
        anr: notApplicable,
        safeMode: unsupported("browser.safe_mode_unavailable"),
        symbolication: probe.symbolUploadConfigured
          ? SUPPORTED
          : degraded("symbols.not_configured"),
      },
    }
  }

  if (probe.platform === "capacitor-ios") {
    return {
      platform: probe.platform,
      checkedAt: (probe.checkedAt ?? new Date()).toISOString(),
      capabilities: {
        javascriptCrash: SUPPORTED,
        nativeCrash: nativeHealthy ? SUPPORTED : degraded("ios.kscrash_probe_failed"),
        minidump: unsupported("ios.uses_kscrash_report"),
        systemDiagnostics:
          (probe.osVersion ?? 0) >= 15
            ? SUPPORTED
            : degraded("ios.immediate_diagnostics_require_ios_15"),
        anr: notApplicable,
        safeMode: safeModeState(probe),
        symbolication: symbols,
      },
    }
  }

  if (probe.platform === "capacitor-android") {
    return {
      platform: probe.platform,
      checkedAt: (probe.checkedAt ?? new Date()).toISOString(),
      capabilities: {
        javascriptCrash: SUPPORTED,
        nativeCrash: nativeHealthy ? SUPPORTED : degraded("android.acra_probe_failed"),
        minidump: unsupported("android.native_minidump_not_configured"),
        systemDiagnostics:
          (probe.apiLevel ?? 0) >= 30
            ? SUPPORTED
            : degraded("android.application_exit_info_requires_api_30"),
        anr: (probe.apiLevel ?? 0) >= 30 ? SUPPORTED : degraded("android.watchdog_only"),
        safeMode: safeModeState(probe),
        symbolication: symbols,
      },
    }
  }

  const desktop =
    probe.platform === "windows" || probe.platform === "macos" || probe.platform === "linux"
  return {
    platform: probe.platform,
    checkedAt: (probe.checkedAt ?? new Date()).toISOString(),
    capabilities: {
      javascriptCrash: desktop ? SUPPORTED : notApplicable,
      nativeCrash: nativeHealthy
        ? SUPPORTED
        : degraded(`${probe.platform}.native_monitor_unhealthy`),
      minidump: desktop
        ? nativeHealthy
          ? SUPPORTED
          : degraded(`${probe.platform}.minidump_monitor_unhealthy`)
        : notApplicable,
      systemDiagnostics: desktop ? SUPPORTED : notApplicable,
      anr: notApplicable,
      safeMode: desktop ? safeModeState(probe) : notApplicable,
      symbolication: symbols,
    },
  }
}
