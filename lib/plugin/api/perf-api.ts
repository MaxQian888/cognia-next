/**
 * Plugin Performance API (`ctx.perf`) — **read-only** access to the Rust
 * performance dashboard (ADR-0035) for monitoring / observability plugins.
 *
 * Wraps the `lib/perf/backend/commands.ts` seam. Deliberately read-only:
 * the sampler-control commands (`perfStartSampling` / `perfSetInterval` /
 * `perfStopSampling` / `perfResetHotspots` / `perfOpenTraceDir`) are NOT
 * exposed — a plugin shouldn't reconfigure the user's sampler or open OS
 * windows. Gated by `perf:read`. Desktop-only (inert empties on web).
 */

import {
  perfSnapshot,
  perfHotspots,
  perfSystemDetails,
  perfListTraces,
  subscribePerfSample,
} from "@/lib/perf/backend/commands"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type {
  PerfSample,
  PerfSnapshot,
  SpanSnapshot,
  SystemDetails,
  TraceFile,
} from "@/lib/perf/backend/types"

export interface PluginPerfAPI {
  /** Recent ring-buffer samples + current sampler state. */
  snapshot(): Promise<PerfSnapshot>
  /** Span hotspot rows (heaviest-first). */
  hotspots(): Promise<SpanSnapshot[]>
  /** Static host + build details (`null` on web). */
  systemDetails(): Promise<SystemDetails | null>
  /** Flight-recorder trace files on disk. */
  listTraces(): Promise<TraceFile[]>
  /** Subscribe to live `perf://sample` frames. Returns a disposer. */
  subscribe(handler: (sample: PerfSample) => void): () => void
}

/** Create the read-only Performance API for a plugin (gated `perf:read`). */
export function createPerfAPI(pluginId: string): PluginPerfAPI {
  const api: PluginPerfAPI = {
    snapshot: () => perfSnapshot(),
    hotspots: () => perfHotspots(),
    systemDetails: () => perfSystemDetails(),
    listTraces: () => perfListTraces(),
    subscribe: (handler) => subscribePerfSample(handler),
  }

  return createGuardedAPI(pluginId, api, {
    snapshot: "perf:read",
    hotspots: "perf:read",
    systemDetails: "perf:read",
    listTraces: "perf:read",
    subscribe: "perf:read",
  })
}
