import { DiagnosticsWorkspace } from "@/components/logging/diagnostics-workspace"

/**
 * `/logs` — one workspace, five channels in local → remote order: Logs,
 * Traces, Errors (`?channel=diagnostics`), Crash reports (`?channel=incidents`,
 * receipts are a filter there) and Service (the diagnostic service's triage
 * console). See `DiagnosticsWorkspace`.
 */
export default function LogsPage() {
  return <DiagnosticsWorkspace />
}
