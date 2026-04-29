"use client"

import { CrashLogSettings } from "@/components/settings/system/crash-log-settings"

/**
 * Settings → Observability → Diagnostics.
 *
 * Hosts the crash-log surface: incident list, native-logging diagnostics,
 * source/level filters, and export controls.
 */
export function DiagnosticsSection() {
  return <CrashLogSettings />
}
