/**
 * Transport Health Hook Types
 */

import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"
import type { TransportHealthSnapshot } from "./transport"

export interface UseTransportHealthOptions {
  autoRefresh?: boolean
  refreshInterval?: number
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
