/**
 * CRUD layer for the `knowledgeNotes` Dexie table (v142).
 *
 * The materialization target for an accepted inbound draft of kind `note`
 * (ADR-0008 Phase 4). Lessons become semantic memories and skill drafts become
 * disabled Skills, both of which have existing homes; a free-form note had
 * none, so this table is it.
 *
 * `body` arrives already wrapped in `<untrusted_content>` by the inbound
 * handler and is stored that way. Nothing here unwraps it — a note originates
 * outside Cognia, and every consumer that puts one in front of a model must
 * keep the envelope (ADR-0008 R7).
 */

import { getDb } from "./schema"

export interface KnowledgeNoteRow {
  id: string
  title: string
  /** Still `<untrusted_content>`-wrapped. See the module note above. */
  body: string
  tags: string[]
  /**
   * The `inboundDrafts.id` this note was materialized from. Doubles as the
   * idempotency key: the worker looks a note up by source draft before
   * creating one, so a retried materialization cannot duplicate it.
   */
  sourceDraftId: string
  /** Which external caller submitted the originating draft, if known. */
  source?: string
  /** Original URL, when the draft carried one. */
  url?: string
  createdAt: number
}

export async function addKnowledgeNote(note: KnowledgeNoteRow): Promise<void> {
  await getDb().knowledgeNotes.put(note)
}

export async function getKnowledgeNote(id: string): Promise<KnowledgeNoteRow | undefined> {
  return getDb().knowledgeNotes.get(id)
}

/**
 * Look a note up by the draft that produced it. The materialization worker
 * calls this first so a replayed job is a no-op instead of a duplicate.
 */
export async function findKnowledgeNoteBySourceDraft(
  sourceDraftId: string
): Promise<KnowledgeNoteRow | undefined> {
  return getDb().knowledgeNotes.where("sourceDraftId").equals(sourceDraftId).first()
}

/** All notes, newest first. */
export async function listKnowledgeNotes(limit = 100): Promise<KnowledgeNoteRow[]> {
  return getDb().knowledgeNotes.orderBy("createdAt").reverse().limit(limit).toArray()
}

/** Notes carrying a given tag, newest first. */
export async function listKnowledgeNotesByTag(
  tag: string,
  limit = 100
): Promise<KnowledgeNoteRow[]> {
  const rows = await getDb().knowledgeNotes.where("tags").equals(tag).toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

export async function deleteKnowledgeNote(id: string): Promise<void> {
  await getDb().knowledgeNotes.delete(id)
}
