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

export type InboundDraftKind = "lesson" | "skill" | "note"
export type InboundDraftStatus = "pending" | "accepted" | "discarded"

export interface InboundDraftRow {
  /** UUID assigned by the handler. */
  id: string
  kind: InboundDraftKind
  status: InboundDraftStatus
  /** Short human title (skill name / lesson topic / note title). */
  title: string
  /** Submitted content, already wrapped in `<untrusted_content>` by the handler. */
  body: string
  /** Free-form structured metadata (tags, skill trigger, source url, …). */
  metadata?: Record<string, unknown>
  /** Which external caller submitted it (device id / agent label, if known). */
  source?: string
  /** Epoch ms. */
  createdAt: number
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

export async function setInboundDraftStatus(id: string, status: InboundDraftStatus): Promise<void> {
  await getDb().inboundDrafts.update(id, { status })
}

export async function deleteInboundDraft(id: string): Promise<void> {
  await getDb().inboundDrafts.delete(id)
}
