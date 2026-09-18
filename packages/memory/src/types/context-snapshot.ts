/**
 * Context snapshot — the delivery receipt for one memory-context injection.
 *
 * `applyMemoryContext` assembles a system-prompt section and hands back a
 * snapshot that binds WHAT was delivered: which rows, at which versions, under
 * which reader, rendered into which bytes. The host then stamps the snapshot
 * onto the assistant message's sources part (`memorySnapshot`), which makes
 * the delivery auditable after the fact — the persisted message IS the
 * receipt, matching how `origin: "memory"` source items already prove which
 * memories the turn cited.
 *
 * `delivery` is a two-step load-ack: the runtime emits `"prepared"`; the host
 * upgrades it to `"delivered"` when the section actually lands on the wire
 * (merged onto the message / appended to the prompt). A snapshot that is
 * prepared but never delivered is evidence the turn ran WITHOUT the context it
 * paid for — the gap the receipt exists to expose.
 *
 * `expiresAt` bounds reuse: a snapshot proves a delivery at a point in time,
 * and once expired it is history, not a live binding — hosts that cache or
 * hand off context must re-snapshot rather than re-deliver stale bytes (the
 * cache-identity constraint: account, principal, policy, corpus and binding
 * epoch are all inputs to a NEW snapshot, never keys on a reused one).
 *
 * Pure type module: no I/O, no `@/` imports.
 */

import type { MemoryReaderContext } from "./memory"

/** One delivered row, bound at the version the turn actually read. */
export interface MemorySnapshotRef {
  id: string
  /** Row `version` at read time — binds content, not just identity. */
  version?: number
}

export type MemorySnapshotDelivery = "prepared" | "delivered" | "expired"

export interface MemoryContextSnapshot {
  /** Stable id — `memctx:<createdAt>:<contentHash>`; identical deliveries share it. */
  id: string
  createdAt: number
  /** The reader context this delivery was authorized for. */
  reader: MemoryReaderContext
  /** Delivered rows (recalled memories; procedural lines are section content). */
  memoryRefs: MemorySnapshotRef[]
  /** Non-cryptographic content hash of the exact rendered section bytes. */
  contentHash: string
  budget: { limit: number; used: number; truncated: boolean }
  /** A degraded pass still delivers (BM25-only / empty) — the receipt says so. */
  degraded: boolean
  /** Wall-clock after which this snapshot may not be re-delivered. */
  expiresAt: number
  delivery: MemorySnapshotDelivery
}

/**
 * How long a prepared snapshot stays deliverable. Bound to one turn's
 * assembly→send window: long enough for retries on the same send, short
 * enough that a stale snapshot can never impersonate a fresh retrieval.
 */
export const MEMORY_SNAPSHOT_TTL_MS = 5 * 60 * 1000

/**
 * djb2 — the same deterministic, non-cryptographic hash the ingest pipeline
 * uses (`lib/project-knowledge/ingest/ingest-file.ts`, including its length
 * fold), re-implemented here because this package is zero-`@/`. Binds
 * snapshot identity to bytes; it is NOT an integrity or authenticity proof.
 */
export function snapshotContentHash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  // Same fold as `hashContent`: a same-hash-different-length pair differs.
  return `${(hash >>> 0).toString(36)}_${text.length.toString(36)}`
}

/** Build a `"prepared"` snapshot for a rendered section. Pure, deterministic. */
export function buildMemoryContextSnapshot(input: {
  reader: MemoryReaderContext
  memoryRefs: MemorySnapshotRef[]
  /** The exact section bytes appended to the prompt ("" when none). */
  sectionText: string
  budget: { limit: number; used: number; truncated: boolean }
  degraded: boolean
  now: number
  /** Override the default TTL (tests, custom delivery windows). */
  ttlMs?: number
}): MemoryContextSnapshot {
  const contentHash = snapshotContentHash(input.sectionText)
  return {
    id: `memctx:${input.now}:${contentHash}`,
    createdAt: input.now,
    reader: input.reader,
    memoryRefs: input.memoryRefs,
    contentHash,
    budget: input.budget,
    degraded: input.degraded,
    expiresAt: input.now + (input.ttlMs ?? MEMORY_SNAPSHOT_TTL_MS),
    delivery: "prepared",
  }
}

/** The load-ack transition — a snapshot the host put on the wire. */
export function markSnapshotDelivered(
  snapshot: MemoryContextSnapshot,
  now: number
): MemoryContextSnapshot {
  if (now > snapshot.expiresAt) return { ...snapshot, delivery: "expired" }
  return { ...snapshot, delivery: "delivered" }
}
