/**
 * TypeScript mirrors of the Rust `perf` subsystem's serde structs
 * (`src-tauri/src/perf/`). Field names are camelCase to match the Rust
 * `#[serde(rename_all = "camelCase")]` attributes.
 *
 * This is the contract behind the Task-Manager-style `/performance` panel.
 */

/** Role of a process in the app's process tree (matches Rust `ProcessRole`). */
export type ProcessRole = "main" | "sidecar" | "child"

/** One process row sampled from the tree. */
export interface ProcessSample {
  pid: number
  parentPid: number | null
  name: string
  role: ProcessRole
  /** CPU normalized to 0–100 across all logical cores. */
  cpuPct: number
  /** Raw sysinfo CPU (sum across cores; can exceed 100). */
  cpuPctRaw: number
  memBytes: number
  diskReadBps: number
  diskWriteBps: number
  /** Seconds the process has been running. */
  runSecs: number
}

/** Point-in-time Tokio runtime snapshot. */
export interface RuntimeSample {
  workers: number
  aliveTasks: number
  globalQueueDepth: number
  blockingThreads: number
  blockingQueueDepth: number
  spawnedTasksCount: number
  budgetForcedYieldCount: number
  /** Cumulative tasks stolen by workers from siblings (sum across workers). */
  workerStealCount: number
  /** Cumulative times workers parked waiting for work (sum across workers). */
  workerParkCount: number
  /** Cumulative times a worker's local queue overflowed to the global queue. */
  workerOverflowCount: number
  /** Mean worker busy % over the interval (0–100). */
  busyPct: number
  /** Per-worker busy % over the interval. */
  perWorkerBusyPct: number[]
}

/** Aggregated stats for one instrumented span (Hotspots table row). */
export interface SpanSnapshot {
  name: string
  count: number
  errorCount: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
  p50Ms: number
  p95Ms: number
  lastTsMs: number
  /** Log-bucket histogram counts (bucket `i` covers `[2^i, 2^(i+1))` µs). */
  buckets: number[]
}

/** System-level memory snapshot for the pressure gauge. */
export interface SystemMemory {
  totalBytes: number
  usedBytes: number
}

/** One composed performance frame emitted on `perf://sample`. */
export interface PerfSample {
  tsMs: number
  intervalMs: number
  processes: ProcessSample[]
  runtime: RuntimeSample
  topSpans: SpanSnapshot[]
  systemMemory: SystemMemory | null
}

/** Initial pull payload from `perf_snapshot`. */
export interface PerfSnapshot {
  samples: PerfSample[]
  running: boolean
  intervalMs: number
}

/** A dial9 flight-recorder trace file on disk. */
export interface TraceFile {
  name: string
  sizeBytes: number
  modifiedMs: number | null
}

/** Static host + build details (mirrors `crash::system_info::SystemDetails`). */
export interface SystemDetails {
  os: string
  osVersion: string | null
  kernelVersion: string | null
  arch: string
  family: string
  hostname: string | null
  cpu: string | null
  cpuCount: number
  totalMemoryBytes: number
  usedMemoryBytes: number
  appVersion: string
  tauriVersion: string
  profile: string
  enabledFeatures: string[]
}
