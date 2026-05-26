/**
 * Type-safe wrappers around the Rust `perf_*` Tauri commands plus the
 * `perf://sample` event subscription. Mirrors the `lib/tauri.ts` seam pattern:
 * business code imports these named functions, never `transport.call` directly.
 *
 * Every wrapper is gated by `isTauri()` so the `/performance` panel degrades to
 * an inert "desktop-only" state on web/mobile instead of throwing.
 */

import { isTauri, transport } from "@/lib/tauri"
import type { PerfSample, PerfSnapshot, SpanSnapshot, SystemDetails, TraceFile } from "./types"

/** Tauri event channel the sampler emits frames on. */
export const PERF_SAMPLE_EVENT = "perf://sample"

const EMPTY_SNAPSHOT: PerfSnapshot = { samples: [], running: false, intervalMs: 1000 }

/** Pull recent ring history + current sampler state. */
export async function perfSnapshot(): Promise<PerfSnapshot> {
  if (!isTauri()) return EMPTY_SNAPSHOT
  return transport.call<PerfSnapshot>("perf_snapshot")
}

/** Start (or reconfigure) the 1 Hz sampler. No-op on web. */
export async function perfStartSampling(intervalMs?: number): Promise<void> {
  if (!isTauri()) return
  await transport.call("perf_start_sampling", { intervalMs })
}

/** Change the sampling cadence without restarting the loop. */
export async function perfSetInterval(intervalMs: number): Promise<void> {
  if (!isTauri()) return
  await transport.call("perf_set_interval", { intervalMs })
}

/** Stop the sampler (called on panel unmount). */
export async function perfStopSampling(): Promise<void> {
  if (!isTauri()) return
  await transport.call("perf_stop_sampling")
}

/** Current span hotspot rows (sorted heaviest-first by the backend). */
export async function perfHotspots(): Promise<SpanSnapshot[]> {
  if (!isTauri()) return []
  return transport.call<SpanSnapshot[]>("perf_hotspots")
}

/** Clear all accumulated span stats. */
export async function perfResetHotspots(): Promise<void> {
  if (!isTauri()) return
  await transport.call("perf_reset_hotspots")
}

/** Static host + build details. `null` on web. */
export async function perfSystemDetails(): Promise<SystemDetails | null> {
  if (!isTauri()) return null
  return transport.call<SystemDetails>("perf_system_details")
}

/** List dial9 flight-recorder trace files on disk. */
export async function perfListTraces(): Promise<TraceFile[]> {
  if (!isTauri()) return []
  return transport.call<TraceFile[]>("perf_list_traces")
}

/** Reveal the trace directory in the OS file manager. */
export async function perfOpenTraceDir(): Promise<void> {
  if (!isTauri()) return
  await transport.call("perf_open_trace_dir")
}

/**
 * Subscribe to live `perf://sample` frames. Returns a synchronous unsubscribe
 * function (no-op on web).
 */
export function subscribePerfSample(handler: (sample: PerfSample) => void): () => void {
  if (!isTauri()) return () => {}
  return transport.subscribe<PerfSample>(PERF_SAMPLE_EVENT, handler)
}
