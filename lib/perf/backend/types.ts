import type {
  PerfLease,
  PerfLeasePurpose,
  PerfSourceDescriptor,
} from "@cognia/plugin-contract/lib/perf/backend/types"
export type {
  ManagedControlAction,
  ManagedProcess,
  ManagedStatus,
  ManagedSubsystem,
  PerfConnectionState,
  PerfFrame,
  PerfFrameFlags,
  PerfGap,
  PerfGapReason,
  PerfLease,
  PerfLeasePurpose,
  PerfRuntimeKind,
  PerfSample,
  PerfSnapshot,
  PerfSourceDescriptor,
  PerfSourceKind,
  ProcessRole,
  ProcessSample,
  RuntimeSample,
  SpanSnapshot,
  SystemDetails,
  SystemMemory,
  TraceFile,
} from "@cognia/plugin-contract/lib/perf/backend/types"

export const PERF_WIRE_VERSION = 1 as const

export type PerfLeaseRejectionCode =
  | "cadence-too-fast"
  | "device-purpose-limit"
  | "host-lease-limit"
  | "rate-limited"
  | "target-mismatch"
  | "routing-generation-mismatch"
  | "unsupported"
  | "permission-denied"

export interface PerfOpenLeaseRequest {
  clientId: string
  deviceId: string
  targetId: string
  routingGeneration: number
  purpose: PerfLeasePurpose
  requestedCadenceMs: number
  sourceId?: string
}

export type PerfOpenLeaseResult =
  | { accepted: true; lease: PerfLease; source: PerfSourceDescriptor }
  | { accepted: false; code: PerfLeaseRejectionCode; detail: string }

export interface TraceHandle {
  handleId: string
  traceId: string
  sizeBytes: number
  sha256: string
  chunkBytes: number
  expiresAtMs: number
}

export interface TraceChunk {
  offset: number
  nextOffset: number
  dataBase64: string
  chunkSha256: string
  eof: boolean
  finalSha256: string | null
}
