// Fixture builders for the Settings → About stories. These feed the loader-prop
// test seams on `SystemDiagnosticsCard` so its "populated" story renders the
// full diagnostics block without any Tauri/native bridge. Spread `over` to vary
// a single field; every required field gets a realistic default.
import type { CrashLoggingDiagnostics } from "@/lib/native/crash-reports"
import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"
import type { OsInfo } from "@/lib/tauri/os"

export function makeOsInfo(over: Partial<OsInfo> = {}): OsInfo {
  return {
    platform: "macos",
    osType: "macOS",
    family: "unix",
    arch: "aarch64",
    version: "15.4.0",
    hostname: "studio.local",
    locale: "en-US",
    ...over,
  }
}

export function makeCrashDiagnostics(
  over: Partial<CrashLoggingDiagnostics> = {}
): CrashLoggingDiagnostics {
  return {
    crashReportCount: 2,
    latestCrashAt: "2026-06-20T09:14:00.000Z",
    latestCrashKind: "panic",
    logDirBytes: 3_407_872,
    retentionMaxAgeDays: 30,
    retentionMaxReports: 50,
    rotatedLogKeep: 5,
    lastPrunePruned: 1,
    lastPruneRemaining: 2,
    ...over,
  }
}

export function makeNativeLoggingReadiness(
  over: Partial<NativeLoggingReadiness> = {}
): NativeLoggingReadiness {
  return {
    runtime: "tauri",
    status: "healthy",
    startupMode: "full",
    startupHealth: "healthy",
    activeTargets: ["file", "console"],
    bridgeState: "active",
    platformLogging: {
      available: true,
      backend: "tracing",
      health: "healthy",
      enabled: true,
      minLevel: "info",
    },
    updatedAt: "2026-06-28T12:00:00.000Z",
    ...over,
  }
}
