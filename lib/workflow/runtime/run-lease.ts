/**
 * Run execution lease (ADR 0061 P4).
 *
 * Exactly one executor process may drive a run. Before the first step,
 * `runWorkflow` claims the run's lease; while the run is live a heartbeat
 * renews it (and watches for cross-executor cancel requests); every
 * terminal path releases it. A second process arriving at the same runId —
 * a crash-resume race between the desktop webview and a future cloud
 * brain, or a double resume after a fast reload — finds a live lease it
 * doesn't own and backs off instead of double-executing.
 *
 * The lease lives on the `workflowRuns` row (additive, non-indexed) so it
 * travels with whatever store hosts the run. Claims go through one Dexie
 * `rw` transaction, which serialises racing claimants.
 */

import { getDb } from "@/lib/db/schema"
import type { WorkflowRunLease } from "@/types/workflow/visual"

/** Default lease TTL. Heartbeats renew at TTL/3, so a dead executor's
 *  lease frees ~30 s after its last beat. */
export const DEFAULT_LEASE_TTL_MS = 30_000

let executorId: string | null = null

/**
 * Stable per-process executor identity. A reload mints a new id — correct,
 * because the old process's lease simply expires.
 */
export function getExecutorId(): string {
  if (executorId === null) {
    executorId = "exec_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10)
  }
  return executorId
}

export type ClaimOutcome = "claimed" | "held" | "not-found"

function isLive(lease: WorkflowRunLease | undefined, nowMs: number): lease is WorkflowRunLease {
  return Boolean(lease && lease.expiresAt > nowMs)
}

/**
 * Claim (or re-claim) the run's lease. Succeeds when the row has no lease,
 * a stale lease, or a lease this process already owns.
 */
export async function claimRunLease(
  runId: string,
  opts: { ownerId?: string; ttlMs?: number; nowMs?: number } = {}
): Promise<ClaimOutcome> {
  const ownerId = opts.ownerId ?? getExecutorId()
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const db = getDb()
  return db.transaction("rw", db.workflowRuns, async () => {
    const row = await db.workflowRuns.get(runId)
    if (!row) return "not-found"
    const now = opts.nowMs ?? Date.now()
    if (isLive(row.lease, now) && row.lease.ownerId !== ownerId) return "held"
    const lease: WorkflowRunLease = {
      ownerId,
      claimedAt: row.lease?.ownerId === ownerId ? row.lease.claimedAt : now,
      expiresAt: now + ttlMs,
    }
    await db.workflowRuns.update(runId, { lease })
    return "claimed"
  })
}

/** Renew if (and only if) this owner still holds the lease. */
export async function renewRunLease(
  runId: string,
  opts: { ownerId?: string; ttlMs?: number; nowMs?: number } = {}
): Promise<boolean> {
  const ownerId = opts.ownerId ?? getExecutorId()
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const db = getDb()
  return db.transaction("rw", db.workflowRuns, async () => {
    const row = await db.workflowRuns.get(runId)
    if (!row?.lease || row.lease.ownerId !== ownerId) return false
    const now = opts.nowMs ?? Date.now()
    await db.workflowRuns.update(runId, {
      lease: { ...row.lease, expiresAt: now + ttlMs },
    })
    return true
  })
}

/** Drop the lease if this owner holds it. Idempotent. */
export async function releaseRunLease(
  runId: string,
  ownerId: string = getExecutorId()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.workflowRuns, async () => {
    const row = await db.workflowRuns.get(runId)
    if (!row?.lease || row.lease.ownerId !== ownerId) return
    // Dexie `update` silently ignores `undefined` — use `modify` to delete.
    await db.workflowRuns
      .where("id")
      .equals(runId)
      .modify((r) => {
        delete r.lease
      })
  })
}

const heartbeats = new Map<string, ReturnType<typeof setInterval>>()

/**
 * Keep the lease fresh while the run executes, and observe cross-executor
 * cancel requests (`cancelRequestedAt` stamped by a surface that couldn't
 * abort locally). Returns a stop function; also registered per runId so
 * `stopLeaseHeartbeat` can tear it down from the release path.
 */
export function startLeaseHeartbeat(
  runId: string,
  opts: {
    ownerId?: string
    ttlMs?: number
    onCancelRequested?: () => void
  } = {}
): () => void {
  const ownerId = opts.ownerId ?? getExecutorId()
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS
  stopLeaseHeartbeat(runId)
  const handle = setInterval(
    () => {
      void (async () => {
        try {
          const row = await getDb().workflowRuns.get(runId)
          if (row?.cancelRequestedAt !== undefined) {
            opts.onCancelRequested?.()
          }
          await renewRunLease(runId, { ownerId, ttlMs })
        } catch {
          // Best-effort — a missed beat just shortens the lease.
        }
      })()
    },
    Math.max(1_000, Math.floor(ttlMs / 3))
  )
  heartbeats.set(runId, handle)
  return () => stopLeaseHeartbeat(runId)
}

export function stopLeaseHeartbeat(runId: string): void {
  const handle = heartbeats.get(runId)
  if (handle !== undefined) {
    clearInterval(handle)
    heartbeats.delete(runId)
  }
}

/** Test-only — reset process identity + heartbeats. */
export function __resetRunLeaseForTesting(): void {
  executorId = null
  for (const handle of heartbeats.values()) clearInterval(handle)
  heartbeats.clear()
}
