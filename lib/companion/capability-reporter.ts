/**
 * Mobile-side capability reporter (ADR-0060).
 *
 * On every transition to `"connected"`, report this device's platform
 * capability manifest (`detectLocalCapabilities()`) to the paired desktop
 * via the `device_capabilities_report` RPC. The desktop persists it onto
 * the caller's `pairedDevices` row (the Rust layer injects the verified
 * `callerDeviceId` — nothing identity-shaped is sent from here).
 *
 * Reports dedupe on payload: the static per-platform baseline can only
 * change across app updates, so one successful report per connection with
 * an unchanged manifest is skipped. Failures are logged and retried on the
 * next connect — the report is a refreshable snapshot, not queued state
 * (deliberately NOT a `MOBILE_OUTBOUND_COMMANDS` member).
 */

import { detectLocalCapabilities } from "@/lib/platform/capabilities"
import { loggers } from "@/lib/logging"
import type { ConnectionState } from "@/lib/tauri/transport-companion"

const log = loggers.sync

/** The transport slice the reporter needs — matches `CompanionTransport`. */
export interface CapabilityReporterTransport {
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  getConnectionState(): ConnectionState
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void
}

/**
 * Install the reporter. Reports immediately when already connected, then on
 * every reconnect. Returns a teardown function (boot-provider cleanup shape).
 */
export function installCapabilityReporter(transport: CapabilityReporterTransport): () => void {
  let lastReported: string | null = null
  let disposed = false

  const report = async (): Promise<void> => {
    const capabilities = [...detectLocalCapabilities()]
    const payloadKey = capabilities.join(",")
    if (payloadKey === lastReported) return
    try {
      await transport.call("device_capabilities_report", { capabilities })
      if (!disposed) lastReported = payloadKey
    } catch (err) {
      // Best-effort: the next connect retries. Never throws into the caller.
      log.warn("capability report failed; will retry on next connect", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (transport.getConnectionState() === "connected") void report()
  const unsubscribe = transport.onConnectionStateChange((state) => {
    if (state === "connected") void report()
  })
  return () => {
    disposed = true
    unsubscribe()
  }
}
