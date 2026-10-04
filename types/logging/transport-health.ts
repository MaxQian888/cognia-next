/**
 * Transport Health Hook Types
 */

import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"
import type { TransportHealthSnapshot } from "@cognia/logging/types/transport"

export interface UseTransportHealthOptions {
  autoRefresh?: boolean
  refreshInterval?: number
  /**
   * `false` skips the hook entirely — no mount-time read, no interval. For a
   * component that can be handed a host's shared poll (the log panel inside
   * `/logs`) and must not start a second one, while still calling the hook
   * unconditionally. Default `true`.
   */
  enabled?: boolean
}

export interface UseTransportHealthResult {
  healthByTransport: Record<string, TransportHealthSnapshot>
  /**
   * Rolling per-transport queue-depth samples sourced from the same polling
   * cadence as `healthByTransport` — consumers can use these to render
   * sparklines without maintaining their own buffers.
   */
  queueDepthHistoryByTransport: Record<string, number[]>
  nativeLogging: NativeLoggingReadiness
  isLoading: boolean
  error: Error | null
  refresh: () => void
}
