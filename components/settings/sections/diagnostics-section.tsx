"use client"

import { CrashLogSettings } from "@/components/settings/system/crash-log-settings"

import { SandboxAuditCard } from "./sandbox-audit-card"
import { SidecarRestartCard } from "./sidecar-restart-card"

/**
 * Settings → Observability → Diagnostics.
 *
 * Hosts the crash-log surface (incident list, native-logging diagnostics,
 * source/level filters, export controls) plus ADR-0028 Phase 14 cards:
 * sandbox event log and sidecar restart counter.
 */
export function DiagnosticsSection() {
  return (
    <div className="space-y-4">
      <CrashLogSettings />
      <SandboxAuditCard />
      <SidecarRestartCard />
    </div>
  )
}
