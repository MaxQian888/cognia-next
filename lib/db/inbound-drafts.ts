/**
 * CRUD layer for the `inboundDrafts` Dexie table (v98) — the External Bridge
 * inbound-write review queue (ADR-0008 Phase 4).
 *
 * External agents contribute lessons / skill drafts / notes via the MCP
 * inbound-write tools (`lib/external-bridge/handlers/inbound.ts`). Nothing is
 * applied to live state: every submission lands here with `status: "pending"`
 * for the operator (a future review UI / `InboundDistiller`) to accept or
 * discard. The submitted body is already wrapped in `<untrusted_content>` by
 * the handler (ADR-0008 R7).
 *
 * The table is capped ([`INBOUND_DRAFTS_CAP`]) so a hostile external agent
 * cannot grow it unbounded — oldest drafts are trimmed on insert.
 */

import { getDb } from "./schema"
import { enqueueInboundMaterialization } from "./inbound-materializations"

export type InboundDraftKind = "lesson" | "skill" | "note"

/**
 * Review decision. The only legal transitions are
 *
 *   pending → accepted
 *   pending → rejected
 *
 * and both destinations are **terminal**. There is no un-accept and no
 * re-open: accepting is a materialization consent, and by the time a draft
 * reaches `accepted` the outbox may already have turned it into a memory, a
 * Skill, or a note. Reversing the decision would leave those behind.
 *
 * v142 rewrote the historical `discarded` value to `rejected` so the union has
 * exactly one spelling for "the operator said no".
 */
export type InboundDraftStatus = "pending" | "accepted" | "rejected"

/** The two terminal states. Nothing may transition out of these. */
export const TERMINAL_INBOUND_STATUSES = ["accepted", "rejected"] as const

export interface InboundDraftRow {
  /** UUID assigned by the handler. */
  id: string
  kind: InboundDraftKind
  status: InboundDraftStatus
  /** Short human title (skill name / lesson topic / note title). */
  title: string
  /** Submitted content, already wrapped in `<untrusted_content>` by the handler. */
  body: string
  /**
   * Operator's edit of `body`, made in the review UI before accepting. When
   * set, this is what materializes — but it is still untrusted-wrapped, because
   * editing hostile text does not make it trusted.
   */
  editedBody?: string
  /** Free-form structured metadata (tags, skill trigger, source url, …). */
  metadata?: Record<string, unknown>
  /** Which external caller submitted it (device id / agent label, if known). */
  source?: string
  /**
   * Content-derived dedup key (see `lib/inbound/canonical-hash.ts`). Optional
   * because drafts created before the distiller existed have none; when set,
   * the distiller refuses to queue a second draft with the same value.
   */
  canonicalHash?: string
  /** Epoch ms. */
  createdAt: number
  /** Epoch ms of the terminal decision. Absent while `pending`. */
  reviewedAt?: number
  /** Free-text reason captured on reject, surfaced in the audit log. */
  rejectionReason?: string
}

/** Thrown when a transition would violate the state machine above. */
export class InboundDraftTransitionError extends Error {
  constructor(
    readonly draftId: string,
    readonly from: InboundDraftStatus | "missing",
    readonly to: InboundDraftStatus
  ) {
    super(`inbound draft ${draftId}: cannot transition ${from} → ${to}`)
    this.name = "InboundDraftTransitionError"
  }
}

/** Keep at most this many drafts; oldest are trimmed on insert. */
export const INBOUND_DRAFTS_CAP = 1000

export async function addInboundDraft(draft: InboundDraftRow): Promise<void> {
  const db = getDb()
  await db.inboundDrafts.put(draft)
  const count = await db.inboundDrafts.count()
  if (count > INBOUND_DRAFTS_CAP) {
    const overflow = count - INBOUND_DRAFTS_CAP
    const oldest = await db.inboundDrafts.orderBy("createdAt").limit(overflow).primaryKeys()
    await db.inboundDrafts.bulkDelete(oldest)
  }
}

export async function getInboundDraft(id: string): Promise<InboundDraftRow | undefined> {
  return getDb().inboundDrafts.get(id)
}

/** All drafts, newest first. */
export async function listInboundDrafts(limit = 100): Promise<InboundDraftRow[]> {
  return getDb().inboundDrafts.orderBy("createdAt").reverse().limit(limit).toArray()
}

/** Pending drafts only (the operator review queue), newest first. */
export async function listPendingInboundDrafts(limit = 100): Promise<InboundDraftRow[]> {
  const rows = await getDb()
    .inboundDrafts.where("status")
    .equals("pending")
    .reverse()
    .sortBy("createdAt")
  return rows.slice(0, limit)
}

/**
 * Accept a draft: CAS `pending → accepted` **and** enqueue its materialization,
 * both inside one Dexie transaction.
 *
 * The atomicity is the point. If the status flip committed without the enqueue,
 * the operator would see an accepted draft that never becomes anything, with no
 * queue row to retry from — a silent drop with no evidence it happened.
 *
 * `editedBody`, when supplied, replaces the body that materializes. It is NOT
 * unwrapped: an operator editing untrusted text does not make it trusted.
 *
 * @throws {InboundDraftTransitionError} if the draft is missing or already terminal.
 */
export async function acceptInboundDraft(
  id: string,
  options: { editedBody?: string; now?: number } = {}
): Promise<InboundDraftRow> {
  const db = getDb()
  const now = options.now ?? Date.now()
  return db.transaction("rw", db.inboundDrafts, db.inboundMaterializations, async () => {
    const row = await db.inboundDrafts.get(id)
    if (!row) throw new InboundDraftTransitionError(id, "missing", "accepted")
    // Compare-and-set. Anything already terminal loses the race and stays put.
    if (row.status !== "pending") {
      throw new InboundDraftTransitionError(id, row.status, "accepted")
    }
    const accepted: InboundDraftRow = {
      ...row,
      status: "accepted",
      reviewedAt: now,
      ...(options.editedBody !== undefined ? { editedBody: options.editedBody } : {}),
    }
    await db.inboundDrafts.put(accepted)
    await enqueueInboundMaterialization(id, row.kind, now)
    return accepted
  })
}

/**
 * Reject a draft: CAS `pending → rejected`. Terminal, and enqueues nothing —
 * a rejected draft never materializes.
 *
 * @throws {InboundDraftTransitionError} if the draft is missing or already terminal.
 */
export async function rejectInboundDraft(
  id: string,
  options: { reason?: string; now?: number } = {}
): Promise<InboundDraftRow> {
  const db = getDb()
  const now = options.now ?? Date.now()
  return db.transaction("rw", db.inboundDrafts, async () => {
    const row = await db.inboundDrafts.get(id)
    if (!row) throw new InboundDraftTransitionError(id, "missing", "rejected")
    if (row.status !== "pending") {
      throw new InboundDraftTransitionError(id, row.status, "rejected")
    }
    const rejected: InboundDraftRow = {
      ...row,
      status: "rejected",
      reviewedAt: now,
      ...(options.reason ? { rejectionReason: options.reason.slice(0, 2000) } : {}),
    }
    await db.inboundDrafts.put(rejected)
    return rejected
  })
}

/**
 * What actually materializes for a draft — the operator's edit when there is
 * one, the original submission otherwise. Both are `<untrusted_content>`-wrapped.
 */
export function materializableBody(row: InboundDraftRow): string {
  return row.editedBody ?? row.body
}

export async function deleteInboundDraft(id: string): Promise<void> {
  await getDb().inboundDrafts.delete(id)
}
