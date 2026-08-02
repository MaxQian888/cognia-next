/**
 * CRUD layer for the `inboundMaterializations` Dexie table (v142) — the
 * accept-side outbox for the inbound review queue (ADR-0008 Phase 4).
 *
 * ## Why an outbox at all
 *
 * Accepting a draft has to do two things: flip `inboundDrafts.status` to
 * `accepted`, and actually turn the draft into a semantic memory / disabled
 * Skill / knowledge note. Those cannot happen in one step — materialization
 * calls out to other subsystems and can fail — but they must not be allowed to
 * disagree. So the accept transaction does the status CAS and *enqueues* here,
 * both inside one Dexie transaction; a separate worker drains the queue.
 *
 * The primary key is the **draft id**, not a generated id. That makes the
 * enqueue idempotent by construction: replaying an accept overwrites the same
 * row rather than queueing the work a second time.
 *
 * ## Why a separate status field
 *
 * `inboundDrafts.status` is a review decision (`pending → accepted | rejected`,
 * both terminal). Materialization is a job lifecycle
 * (`queued → running → completed | failed`) that can be retried. Folding the
 * two together would mean a failed materialization has to un-accept a draft the
 * operator already approved. They stay separate: the review decision is final,
 * the job retries underneath it.
 */

import { getDb } from "./schema"
import type { InboundDraftKind } from "./inbound-drafts"

export type InboundMaterializationStatus = "queued" | "running" | "completed" | "failed"

export interface InboundMaterializationRow {
  /** Primary key — the `inboundDrafts.id` being materialized. */
  draftId: string
  kind: InboundDraftKind
  status: InboundMaterializationStatus
  queuedAt: number
  startedAt?: number
  finishedAt?: number
  /**
   * Id of the row this draft became — a `memories.id`, `skills.id`, or
   * `knowledgeNotes.id` depending on `kind`. Set on `completed`, and used to
   * make a replayed job a no-op.
   */
  producedId?: string
  /** Failure message for `failed`. Retained across retries for the review UI. */
  error?: string
  /** Incremented on each retry so the UI can show "attempt 3". */
  attempts: number
}

/**
 * Enqueue (or re-enqueue) materialization for a draft.
 *
 * Caller is responsible for running this inside the same transaction as the
 * `inboundDrafts` status CAS — see `lib/db/inbound-drafts.ts:acceptInboundDraft`,
 * which is the only intended caller.
 */
export async function enqueueInboundMaterialization(
  draftId: string,
  kind: InboundDraftKind,
  now = Date.now()
): Promise<void> {
  await getDb().inboundMaterializations.put({
    draftId,
    kind,
    status: "queued",
    queuedAt: now,
    attempts: 0,
  })
}

export async function getInboundMaterialization(
  draftId: string
): Promise<InboundMaterializationRow | undefined> {
  return getDb().inboundMaterializations.get(draftId)
}

/**
 * Compound-range bounds for `[status+queuedAt]`. `queuedAt` is always a number,
 * so `-Infinity` sits below every real value; an empty array sorts above every
 * number in the IndexedDB key ordering, so it sits above every real value.
 */
const QUEUED_AT_MIN = -Infinity
const QUEUED_AT_MAX: unknown[] = []

/**
 * Oldest-first queue drain. `queued` only — a `running` row belongs to an
 * in-flight worker, and re-picking it would double-materialize.
 */
export async function listQueuedMaterializations(limit = 50): Promise<InboundMaterializationRow[]> {
  return getDb()
    .inboundMaterializations.where("[status+queuedAt]")
    .between(["queued", QUEUED_AT_MIN], ["queued", QUEUED_AT_MAX])
    .limit(limit)
    .toArray()
}

/** Rows the operator can retry: failed, newest first. */
export async function listFailedMaterializations(limit = 50): Promise<InboundMaterializationRow[]> {
  const rows = await getDb().inboundMaterializations.where("status").equals("failed").toArray()
  return rows.sort((a, b) => b.queuedAt - a.queuedAt).slice(0, limit)
}

/** Claim a queued row for a worker. */
export async function markMaterializationRunning(draftId: string, now = Date.now()): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.inboundMaterializations, async () => {
    const row = await db.inboundMaterializations.get(draftId)
    if (!row) return
    await db.inboundMaterializations.put({
      ...row,
      status: "running",
      startedAt: now,
      attempts: row.attempts + 1,
    })
  })
}

/**
 * Read-modify-put rather than `update()`.
 *
 * Dexie's `Table.update()` treats an `undefined` value as "leave this field
 * alone", so `{ error: undefined }` does NOT clear a previous failure — the
 * review UI would then show a stale error next to a materialization that
 * actually succeeded. Rebuilding the row is the only way to drop the key.
 */
export async function markMaterializationCompleted(
  draftId: string,
  producedId: string,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.inboundMaterializations, async () => {
    const row = await db.inboundMaterializations.get(draftId)
    if (!row) return
    const { error: _cleared, ...rest } = row
    await db.inboundMaterializations.put({
      ...rest,
      status: "completed",
      producedId,
      finishedAt: now,
    })
  })
}

export async function markMaterializationFailed(
  draftId: string,
  error: string,
  now = Date.now()
): Promise<void> {
  await getDb().inboundMaterializations.update(draftId, {
    status: "failed",
    finishedAt: now,
    error: error.slice(0, 2000),
  })
}

/**
 * Put a failed row back on the queue. Keeps `attempts` — the count is the
 * whole point of showing a retry in the UI.
 *
 * Read-modify-put for the same reason as {@link markMaterializationCompleted}:
 * `update()` cannot clear `error` / `finishedAt`, and a re-queued row carrying
 * the previous run's failure reads as though the retry already failed.
 */
export async function retryMaterialization(draftId: string, now = Date.now()): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.inboundMaterializations, async () => {
    const row = await db.inboundMaterializations.get(draftId)
    if (!row) return
    const { error: _clearedError, finishedAt: _clearedFinishedAt, ...rest } = row
    await db.inboundMaterializations.put({ ...rest, status: "queued", queuedAt: now })
  })
}

export async function deleteInboundMaterialization(draftId: string): Promise<void> {
  await getDb().inboundMaterializations.delete(draftId)
}
