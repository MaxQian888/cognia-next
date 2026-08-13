import type { PerfGapReason, PerfLeasePurpose, PerfSourceKind } from "./backend/types"

export type PerfCaptureStatus = "recording" | "finalizing" | "importing" | "ready" | "failed"
export type PerfCaptureStopReason =
  | "manual"
  | "duration-limit"
  | "target-switched"
  | "remote-timeout"
  | "terminal-host-state"
  | "account-locked"
  | "quota-exceeded"
  | "client-terminated"

export type PerfSignatureTrustState =
  "verified" | "valid-untrusted" | "origin-unverified" | "rejected-invalid"

/** Plaintext metadata is intentionally structural only. */
export interface PerformanceCaptureRow {
  id: string
  status: PerfCaptureStatus
  purpose: PerfLeasePurpose
  sourceKind: PerfSourceKind
  sourceId: string
  hostInstanceId: string
  targetId: string
  routingGeneration: number
  wireVersion: number
  metricSchemaVersion: number
  capabilityBits: string
  startedAt: number
  updatedAt: number
  stoppedAt?: number
  stopReason?: PerfCaptureStopReason
  pinned: 0 | 1
  payloadBytes: number
  attachmentBytes: number
  frameCount: number
  gapCount: number
  environmentDigest?: string
  metadataContentType?: "application/vnd.cognia.perf-metadata+json"
  metadataByteCount?: number
  metadataDigest?: string
  metadataIv?: ArrayBuffer
  metadataCiphertext?: ArrayBuffer
  digest?: string
  originalCaptureId?: string
  originalDigest?: string
  importedAt?: number
  trustState?: PerfSignatureTrustState
}

export interface PerformanceCaptureChunkRow {
  id: string
  captureId: string
  ordinal: number
  frameCount: number
  firstSequence: number
  lastSequence: number
  byteCount: number
  contentType: "application/vnd.cognia.perf-frames+json"
  iv: ArrayBuffer
  ciphertext: ArrayBuffer
  digest: string
}

export interface PerformanceCaptureAttachmentRow {
  id: string
  captureId: string
  ordinal: number
  byteCount: number
  contentType: string
  iv: ArrayBuffer
  ciphertext: ArrayBuffer
  digest: string
}

export interface PerformanceCaptureGapRow {
  id: string
  captureId: string
  ordinal: number
  reason: PerfGapReason
  recoverable: 0 | 1
  sequenceStart?: number
  sequenceEnd?: number
  wallStartMs: number
  wallEndMs: number
  clockUncertaintyMs?: number
}
