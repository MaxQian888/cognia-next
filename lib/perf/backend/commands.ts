/**
 * Type-safe wrappers around the Rust `perf_*` Tauri commands plus the
 * `perf://sample` event subscription. Mirrors the `lib/tauri.ts` seam pattern:
 * business code imports these named functions, never `transport.call` directly.
 *
 * Every wrapper is gated by `isTauri()` so the `/performance` panel degrades to
 * an inert "desktop-only" state on web/mobile instead of throwing.
 */

import { isTauri, transport } from "@/lib/tauri"
import type {
  ManagedControlAction,
  ManagedProcess,
  ManagedSubsystem,
  PerfFrame,
  PerfOpenLeaseRequest,
  PerfOpenLeaseResult,
  PerfSample,
  PerfSnapshot,
  SpanSnapshot,
  SystemDetails,
  TraceFile,
  TraceHandle,
  TraceChunk,
} from "./types"

/** Tauri event channel the sampler emits frames on. */
export const PERF_SAMPLE_EVENT = "perf://sample"
export const PERF_FRAME_EVENT = "perf://frame"

export const EMPTY_PERF_SNAPSHOT: PerfSnapshot = {
  wireVersion: 1,
  frames: [],
  oldestSequence: null,
  latestSequence: null,
  sources: [],
  leases: [],
  gaps: [],
  samples: [],
  running: false,
  intervalMs: 1000,
}

/** Pull recent ring history + current sampler state. */
export async function perfSnapshot(): Promise<PerfSnapshot> {
  if (!isTauri()) return EMPTY_PERF_SNAPSHOT
  return transport.call<PerfSnapshot>("perf_snapshot")
}

export async function perfOpenLease(input: PerfOpenLeaseRequest): Promise<PerfOpenLeaseResult> {
  return transport.call<PerfOpenLeaseResult>("perf_open_lease", { input })
}

export async function perfRenewLease(leaseId: string): Promise<void> {
  await transport.call("perf_renew_lease", { leaseId })
}

export async function perfCloseLease(leaseId: string): Promise<void> {
  await transport.call("perf_close_lease", { leaseId })
}

export async function perfLeaseSnapshot(leaseId: string): Promise<PerfSnapshot> {
  return transport.call<PerfSnapshot>("perf_lease_snapshot", { leaseId })
}

export async function perfReadObservations(
  leaseId: string,
  afterSequence?: number
): Promise<PerfFrame[]> {
  return transport.call<PerfFrame[]>("perf_read_observations", { leaseId, afterSequence })
}

export function subscribePerfFrame(handler: (frame: PerfFrame) => void): () => void {
  return transport.subscribe<PerfFrame>(PERF_FRAME_EVENT, handler)
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

/** Selected-host system details. Call only when the source advertises this capability. */
export async function perfReadSystemDetails(): Promise<SystemDetails> {
  return transport.call<SystemDetails>("perf_system_details")
}

/** List dial9 flight-recorder trace files on disk. */
export async function perfListTraces(): Promise<TraceFile[]> {
  if (!isTauri()) return []
  return transport.call<TraceFile[]>("perf_list_traces")
}

export async function perfOpenTrace(traceId: string): Promise<TraceHandle> {
  return transport.call<TraceHandle>("perf_trace_open", { traceId })
}

export async function perfReadTraceChunk(
  handleId: string,
  offset: number,
  length?: number
): Promise<TraceChunk> {
  return transport.call<TraceChunk>("perf_trace_read_chunk", { handleId, offset, length })
}

export async function perfCloseTrace(handleId: string): Promise<void> {
  await transport.call("perf_trace_close", { handleId })
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

/**
 * List every cognia-managed child process. The performance panel reads the same
 * data off `PerfSample.managed`; this is for non-perf callers. `[]` on web.
 */
export async function listManagedProcesses(): Promise<ManagedProcess[]> {
  if (!isTauri()) return []
  return transport.call<ManagedProcess[]>("list_managed_processes")
}

/**
 * Control a Rust-supervised managed process (kill / restart). External agents
 * are NOT routed here — the renderer controls them through
 * `ExternalAgentManager` (see `managed-control.ts`).
 */
export async function controlManagedProcess(
  subsystem: ManagedSubsystem,
  id: string,
  action: ManagedControlAction
): Promise<void> {
  if (!isTauri()) return
  await transport.call("control_managed_process", { subsystem, id, action })
}
