/**
 * Backlink index — which turns cited which record.
 *
 * `metadata.mentions` has been written on every user message since the
 * `ContextRef` layer landed, and its own type docs call it "the only record
 * that the turn cited that document". `lib/db/chat-search-text.ts` reads it to
 * fold citation labels into the search projection; nothing has ever read it the
 * other way round. So the app could answer "what did this message reference"
 * and never "what referenced this record" — which is the question you have
 * after being handed a memory, an issue, or a conversation someone reused.
 *
 * A third derived table on the same terms as its two siblings: one lean row per
 * (message, ref), rebuildable from `messages` at any time, keyed so a
 * re-projection overwrites rather than accumulates, and filled by the SAME
 * descending walk — reading rows with their `parts` is the expensive part, and
 * this needs only their `metadata`.
 */

import type { StoredMessage } from "@cognia/agent-config-types"

import { getMessageMentions } from "@/lib/chat/mentions/read"
import type { ContextRefKind } from "@/lib/chat/mentions/types"
import { getDb } from "./schema"

export interface MentionLinkRow {
  /** `messageId` NUL `refKind` NUL `refId` — one row per citation. */
  linkId: string
  refKind: ContextRefKind
  /** The cited record's id, in the ref's own vocabulary (`session:s_1`, a relPath). */
  refId: string
  /** Human label as the citing turn recorded it, for a list that reads without a join. */
  refLabel?: string
  messageId: string
  sessionId: string
  /** `""` for pre-isolation rows, never `undefined` — see `ChatSearchTextRow`. */
  projectId: string
  createdAt: number
}

/** Backfill bookkeeping, mirroring `chatSearchState`. */
export interface MentionLinkStateRow {
  id: "singleton"
  oldestProjectedAt: number | null
  oldestProjectedId: string | null
  complete: boolean
  updatedAt: number
}

export const DEFAULT_MENTION_LINK_STATE: MentionLinkStateRow = {
  id: "singleton",
  oldestProjectedAt: null,
  oldestProjectedId: null,
  complete: false,
  updatedAt: 0,
}

/**
 * NUL-separated, like the composer's candidate cache key and the search
 * corpus's haystack: a `refId` is opaque (a relPath, an agent handle,
 * `session:s_1`) and any separator that can occur inside one lets two different
 * citations collide on a single primary key.
 */
export function mentionLinkId(messageId: string, refKind: string, refId: string): string {
  return `${messageId}\u0000${refKind}\u0000${refId}`
}

/** The `[refKind+refId]` half of the lookup, as one indexable value. */
export function mentionTargetKey(refKind: string, refId: string): [string, string] {
  return [refKind, refId]
}

/**
 * Every citation one message made.
 *
 * Deduplicated by `(kind, id)`: a turn that mentions the same file twice cited
 * it once, and two rows would double it in every count this table exists to
 * produce.
 *
 * Reads `metadata.mentions` ONLY — deliberately not `getMessageMentions`'s
 * legacy text fallback. That fallback re-parses `@` tokens out of a message's
 * prose, and `resolveMentions` types every token it cannot resolve as a FILE.
 * Turning it on here would fill the file backlinks with things that were never
 * files, while recovering none of the entity citations the panels actually
 * query — a chip-style pick (`@memory:`, `@issue:`, `@chat:`) leaves no token
 * in the text at all, so there is nothing in a legacy message to recover. A
 * pre-ContextRef message therefore has no backlinks, which is the honest
 * answer rather than a noisy one.
 */
export function projectMessageMentionLinks(message: StoredMessage): MentionLinkRow[] {
  const refs = getMessageMentions({ metadata: message.metadata })
  if (refs.length === 0) return []
  const seen = new Set<string>()
  const rows: MentionLinkRow[] = []
  for (const ref of refs) {
    const linkId = mentionLinkId(message.id, ref.kind, ref.id)
    if (seen.has(linkId)) continue
    seen.add(linkId)
    rows.push({
      linkId,
      refKind: ref.kind,
      refId: ref.id,
      ...(ref.label ? { refLabel: ref.label } : {}),
      messageId: message.id,
      sessionId: message.sessionId,
      projectId: message.projectId ?? "",
      createdAt: message.createdAt,
    })
  }
  return rows
}

export async function putMentionLinks(rows: readonly MentionLinkRow[]): Promise<void> {
  if (rows.length === 0) return
  await getDb().mentionLinks.bulkPut(rows as MentionLinkRow[])
}

export async function deleteMentionLinksForMessages(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const db = getDb()
  const keys = await db.mentionLinks
    .where("messageId")
    .anyOf(ids as string[])
    .primaryKeys()
  if (keys.length > 0) await db.mentionLinks.bulkDelete(keys as string[])
}

export async function deleteMentionLinksForSession(sessionId: string): Promise<void> {
  await getDb().mentionLinks.where("sessionId").equals(sessionId).delete()
}

/**
 * Reconcile one session's links against a freshly-read message list.
 *
 * Whole-session, like its siblings: an edited or truncated turn REMOVES
 * citations, and an append-only index would keep claiming a record is
 * referenced by a message that no longer mentions it.
 */
export async function reconcileSessionMentionLinks(
  sessionId: string,
  messages: readonly StoredMessage[]
): Promise<{ written: MentionLinkRow[]; removed: string[] }> {
  const db = getDb()
  const written = messages.flatMap((message) => projectMessageMentionLinks(message))
  const existing = (await db.mentionLinks
    .where("sessionId")
    .equals(sessionId)
    .primaryKeys()) as string[]
  const keep = new Set(written.map((r) => r.linkId))
  const removed = existing.filter((id) => !keep.has(id))
  if (removed.length > 0) await db.mentionLinks.bulkDelete(removed)
  await putMentionLinks(written)
  return { written, removed }
}

export async function getMentionLinkState(): Promise<MentionLinkStateRow> {
  const row = await getDb().mentionLinkState.get("singleton")
  return row ?? DEFAULT_MENTION_LINK_STATE
}

export async function setMentionLinkState(
  patch: Partial<Omit<MentionLinkStateRow, "id" | "updatedAt">>
): Promise<void> {
  const current = await getMentionLinkState()
  await getDb().mentionLinkState.put({
    ...current,
    ...patch,
    id: "singleton",
    updatedAt: Date.now(),
  })
}

/** Rows citing one record, newest-first. An index probe, never a scan. */
export async function listMentionLinksFor(
  refKind: string,
  refId: string,
  limit = 50
): Promise<MentionLinkRow[]> {
  if (limit <= 0) return []
  const rows = await getDb()
    .mentionLinks.where("[refKind+refId]")
    .equals(mentionTargetKey(refKind, refId))
    .toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

/** How many turns cite one record. Drives the badge, so it must not read rows. */
export async function countMentionLinksFor(refKind: string, refId: string): Promise<number> {
  return getDb()
    .mentionLinks.where("[refKind+refId]")
    .equals(mentionTargetKey(refKind, refId))
    .count()
}
