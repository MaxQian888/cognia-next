/**
 * Conditional, idempotent mutation boundary for external memory surfaces.
 *
 * `updateExternalMemory` / `forgetExternalMemory` used to read a row, check a
 * policy, and write later — three separate reads/writes a concurrent mutation
 * could interleave into, with no way for a retried request to be told apart
 * from a new one. This module owns the single Dexie transaction that now
 * performs all of:
 *
 *   1. `memoryOperations` receipt lookup — a replayed `operationId` with the
 *      same `requestHash` returns its recorded outcome; the same id with a
 *      DIFFERENT hash is refused (`idempotency_key_reused`), because an
 *      idempotency key is a promise about a request, not a slot to reuse.
 *   2. `expectedVersion` compare — the row's `version` at commit time must
 *      equal what the caller saw, or the write conflicts instead of
 *      silently losing the other writer's change.
 *   3. the memory patch + version bump + audit rows + the operation receipt —
 *      one transaction, so a crash between them cannot leave a write without
 *      its ledger entry.
 *
 * What deliberately stays OUTSIDE the transaction: PII checks, policy
 * resolution, and the best-effort vector re-sync. Those are async lookups and
 * network I/O; Dexie auto-commits a transaction the moment a non-Dexie
 * promise is awaited inside it, so the callback here receives only plain data
 * the caller already resolved.
 *
 * Only APPLIED operations get a receipt: a denied or conflicted request left
 * no side effect, so a retry evaluates fresh. (The alternative — recording
 * failures — would pin `version_conflict` onto an operation id even after the
 * caller re-read and fixed its expectation.)
 */

import type { Memory } from "@/types/memory/memory"
import type { MemoryAuditAction, MemoryOperationRow } from "@/types/memory/governance"
import { getDb } from "./schema"

export interface MemoryOperationBinding {
  /** `TrustedMemoryCaller.principalId` — namespaces the operation id. */
  principalId: string
  /** Caller-supplied idempotency key. */
  operationId: string
  /** djb2 hash of the canonical request payload (kind + memoryId + patch). */
  requestHash: string
  kind: MemoryOperationRow["kind"]
}

export type MemoryMutationOutcome =
  | { ok: true; version: number }
  | {
      ok: false
      reason: "not_found" | "version_conflict" | "idempotency_key_reused"
      /** Row version at conflict time — lets the caller re-read and retry. */
      currentVersion?: number
    }

export interface MemoryMutationRequest {
  memoryId: string
  /** CAS guard; absent = unconditional (legacy callers, local surfaces). */
  expectedVersion?: number
  /** Absent = no idempotency tracking. */
  operation?: MemoryOperationBinding
  /**
   * Produce the row patch + audit entries. Runs INSIDE the transaction —
   * Dexie-only, no imports, no I/O. `existing` is the freshly re-read row.
   */
  apply: (existing: Memory) => {
    patch: Partial<Memory>
    audits?: { action: MemoryAuditAction; reason: string }[]
  }
}

/**
 * Whether a live row still matches the identity a stale caller may have read:
 * scope + namespace fields. `expectedVersion` covers the row's own changes;
 * this covers a relocation (`relocateMemoryNamespace` bumps nothing else the
 * caller could have checked) — a row moved to a namespace the policy was
 * resolved against must not be writable under the stale read.
 */
function namespaceUnchanged(
  existing: Memory,
  seen: Pick<Memory, "scope" | "projectId" | "characterId" | "agentId">
): boolean {
  return (
    existing.scope === seen.scope &&
    existing.projectId === seen.projectId &&
    existing.characterId === seen.characterId &&
    existing.agentId === seen.agentId
  )
}

export async function runMemoryMutation(
  request: MemoryMutationRequest & {
    /** The row the caller already read — used for the namespace recheck. */
    seen: Pick<Memory, "scope" | "projectId" | "characterId" | "agentId">
  }
): Promise<MemoryMutationOutcome> {
  const db = getDb()
  return db.transaction(
    "rw",
    [db.memories, db.memoryAuditEvents, db.memoryOperations],
    async () => {
      const operationKey = request.operation
        ? `${request.operation.principalId}:${request.operation.operationId}`
        : undefined
      if (request.operation && operationKey) {
        const prior = await db.memoryOperations.get(operationKey)
        if (prior) {
          if (prior.requestHash !== request.operation.requestHash) {
            return { ok: false, reason: "idempotency_key_reused" }
          }
          // A `pending` row is a `store` reservation mid-flight on the same
          // key; identical request → apply normally, our receipt replaces the
          // marker. Only a RECORDED receipt short-circuits.
          if (prior.resultCode !== MEMORY_OPERATION_PENDING) {
            return { ok: true, version: prior.resultVersion ?? 0 }
          }
        }
      }

      const existing = await db.memories.get(request.memoryId)
      if (!existing) return { ok: false, reason: "not_found" }
      if (!namespaceUnchanged(existing, request.seen)) {
        // The row moved namespaces between the caller's read and this commit —
        // report it as a conflict so the caller re-reads under the new
        // namespace instead of writing through a stale authorization.
        return { ok: false, reason: "version_conflict", currentVersion: existing.version }
      }
      if (request.expectedVersion !== undefined && existing.version !== request.expectedVersion) {
        return { ok: false, reason: "version_conflict", currentVersion: existing.version }
      }

      const applied = request.apply(existing)
      const now = Date.now()
      // An empty patch is a true no-op (e.g. forgetting an already-invalidated
      // row): no version bump, no `updatedAt` stamp — the BM25 corpus cache
      // keys on `updatedAt`, so a no-op must not re-tokenise the corpus.
      const changed = Object.keys(applied.patch).length > 0
      const version = changed ? existing.version + 1 : existing.version
      if (changed) {
        await db.memories.update(request.memoryId, {
          ...applied.patch,
          version,
          updatedAt: now,
        })
      }
      for (const [index, audit] of (applied.audits ?? []).entries()) {
        await db.memoryAuditEvents.add({
          id: `mau_${request.memoryId}_${now}_${index}`,
          action: audit.action,
          memoryId: request.memoryId,
          reason: audit.reason,
          createdAt: now,
        })
      }
      if (request.operation && operationKey) {
        const receipt: MemoryOperationRow = {
          id: operationKey,
          principalId: request.operation.principalId,
          operationId: request.operation.operationId,
          kind: request.operation.kind,
          requestHash: request.operation.requestHash,
          memoryId: request.memoryId,
          resultCode: "ok",
          resultVersion: version,
          createdAt: now,
        }
        await db.memoryOperations.put(receipt)
      }
      return { ok: true, version }
    }
  )
}

/**
 * Canonical request hash for the idempotency ledger. `hashContent` is the
 * shared deterministic helper the ingest pipeline already uses — this is a
 * caller-bug detector (did the same operation id arrive with a different
 * request?), not a security primitive, so a cheap djb2 is the right size.
 */
export async function memoryOperationRequestHash(
  kind: MemoryOperationRow["kind"],
  payload: unknown
): Promise<string> {
  const { hashContent } = await import("@/lib/project-knowledge/ingest/ingest-file")
  return hashContent(canonicalJson({ kind, payload: payload ?? null }))
}

/**
 * Deterministic JSON: object keys sorted at every depth. Two transports
 * serializing the same logical request in different key orders must still
 * produce the same hash — `JSON.stringify` alone would split them.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
  return `{${entries.join(",")}}`
}

/**
 * Look up an operation receipt — the read-only half of idempotency, for
 * mutation paths whose apply step cannot live inside this transaction
 * (e.g. `store`, which runs the consolidator). Present the receipt, don't
 * re-run.
 */
export async function findMemoryOperation(
  principalId: string,
  operationId: string
): Promise<MemoryOperationRow | undefined> {
  return getDb().memoryOperations.get(`${principalId}:${operationId}`)
}

/**
 * Record an applied operation after a write that could not share the
 * mutation transaction. Best-effort by construction — the write is already
 * durable; a lost receipt just means the next replay re-runs the (dedupe-
 * capable) apply path.
 */
export async function recordMemoryOperation(row: MemoryOperationRow): Promise<void> {
  await getDb().memoryOperations.put(row)
}

/** `resultCode` marker for an operation that has been claimed but not applied. */
export const MEMORY_OPERATION_PENDING = "pending"

export type MemoryOperationReservation =
  /** We hold the key — caller proceeds to execute, then records the receipt. */
  | { state: "reserved" }
  /** A recorded receipt exists for an identical request — replay it. */
  | { state: "replay"; receipt: MemoryOperationRow }
  /** Same operation id, DIFFERENT request — refuse (caller bug). */
  | { state: "conflict" }
  /** An identical request is applying right now on another turn/tab. */
  | { state: "in_flight" }

/**
 * Atomically claim `(principalId, operationId)` for a mutation whose apply
 * step cannot share a Dexie transaction (the `store` path runs the async
 * consolidator). The check-and-mark is one transaction, so two concurrent
 * identical stores cannot both pass the receipt lookup: the second observes
 * `in_flight` and waits on {@link awaitMemoryOperation} instead of
 * consolidating a duplicate.
 */
export async function reserveMemoryOperation(
  binding: MemoryOperationBinding
): Promise<MemoryOperationReservation> {
  const db = getDb()
  const key = `${binding.principalId}:${binding.operationId}`
  return db.transaction("rw", db.memoryOperations, async () => {
    const prior = await db.memoryOperations.get(key)
    if (prior) {
      if (prior.requestHash !== binding.requestHash) return { state: "conflict" }
      if (prior.resultCode === MEMORY_OPERATION_PENDING) return { state: "in_flight" }
      return { state: "replay", receipt: prior }
    }
    await db.memoryOperations.put({
      id: key,
      principalId: binding.principalId,
      operationId: binding.operationId,
      kind: binding.kind,
      requestHash: binding.requestHash,
      memoryId: "",
      resultCode: MEMORY_OPERATION_PENDING,
      createdAt: Date.now(),
    })
    return { state: "reserved" }
  })
}

/**
 * Release a reservation the caller never turned into a receipt — a denied or
 * failed store leaves no side effect, so its key must free up for a corrected
 * retry. Deletes only while the row is still OUR pending marker (same hash):
 * a row that became a receipt, or belongs to a different request, stays.
 */
export async function releaseMemoryOperation(
  principalId: string,
  operationId: string,
  requestHash: string
): Promise<void> {
  const db = getDb()
  const key = `${principalId}:${operationId}`
  await db.transaction("rw", db.memoryOperations, async () => {
    const row = await db.memoryOperations.get(key)
    if (row?.resultCode === MEMORY_OPERATION_PENDING && row.requestHash === requestHash) {
      await db.memoryOperations.delete(key)
    }
  })
}

/**
 * Wait for an `in_flight` operation to settle into a receipt. Returns the
 * recorded row, or `undefined` on timeout — the caller then proceeds with its
 * own execution (the consolidator dedupes identical text, so the degraded
 * path is a NOOP/UPDATE, not a duplicate row).
 *
 * A DISAPPEARED row exits immediately: this function is only reached after
 * `reserveMemoryOperation` observed a pending marker, so a missing row means
 * `releaseMemoryOperation` freed it — the other writer failed and its key is
 * already free. Waiting out the timeout would only delay the retry.
 */
export async function awaitMemoryOperation(
  principalId: string,
  operationId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<MemoryOperationRow | undefined> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await findMemoryOperation(principalId, operationId)
    if (row && row.resultCode !== MEMORY_OPERATION_PENDING) return row
    if (!row) return undefined
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
