"use client"

import { CrashLogSettings } from "@/components/settings/system/crash-log-settings"

import { SandboxAuditCard } from "./sandbox-audit-card"
import { SidecarRestartCard } from "./sidecar-restart-card"
import { InboxTelemetryCard } from "./inbox-telemetry-card"

/**
 * Settings → Observability → Diagnostics.
 *
 * Hosts the crash-log surface (incident list, native-logging diagnostics,
 * source/level filters, export controls), the ADR-0028 Phase 14 cards
 * (sandbox event log + sidecar restart counter), and the v49 inbox
 * telemetry breadcrumb exporter.
 */
export function DiagnosticsSection() {
  return (
    <div className="space-y-4">
      <CrashLogSettings />
      <SandboxAuditCard />
      <SidecarRestartCard />
      <InboxTelemetryCard />
    </div>
  )
}
