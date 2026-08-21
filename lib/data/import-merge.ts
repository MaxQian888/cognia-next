// Guarded persistence for external-agent session imports (ADR-0062 fidelity
// upgrade). A naive `bulkPut` replaces the whole `ChatSession` row, which — on
// a RE-import of a session the user already continued in Cognia — would wipe
// its `sdkSessionId` (breaking SDK resume) plus every local decoration (pin,
// folder, manual order, rename, archive). Live fs-watch re-imports make that
// re-import path routine, so the write must merge instead of clobber:
//
//   • `importFrozen` session  → SKIP the content entirely. The user continued
//     it, so Cognia owns the thread; source-side edits must never touch it.
//     They are not silently dropped either: when the source has actually MOVED
//     since the last mirrored import, the row is flagged `importDiverged` and
//     the chat header says so (`components/chat/imported-origin-chip.tsx`).
//     That badge is what this comment promised for a long time while nothing
//     in the app read `importFrozen` at all. Freeze is set in
//     `use-claude-chat-controller.ts` on the first continuation.
//   • otherwise                → refresh CONTENT (messages, auto-title, detected
//     model, workingDir, updatedAt, branchSeed) from the freshly-parsed
//     conversation, but PRESERVE the user's local decorations from the existing
//     row.
//
// The chat-export importers reach this via `applyImported` too, but they mint
// fresh random ids so `existing` is always undefined and the merge is a no-op —
// behaviour is unchanged for that path.

import type { ImportedConversation } from "./importers/types"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import { normalizeStoredMessageMedia } from "@/lib/chat/media/normalize-message-media"
import { invalidateResidentCorpus } from "@/lib/chat/search/engine"
import { projectMessageToSearchRow, type ChatSearchTextRow } from "@/lib/db/chat-search-text"
import { collectUnreferencedMessageMedia, messageMediaRefRows } from "@/lib/db/message-media-refs"
import { getDb } from "@/lib/db/schema"

type Db = ReturnType<typeof getDb>

/**
 * Fields owned by the user (or by SDK continuity), preserved verbatim from the
 * existing row on re-import when present. Everything else is refreshed from the
 * re-parsed source so the mirror stays current.
 *
 * `branchSeed` is intentionally NOT here: a non-frozen session hasn't been
 * continued, so refreshing its seed keeps a future first-continuation grounded
 * in the latest source context. (A continued session is frozen → skipped, so
 * its already-cleared seed is never revisited.)
 */
const PRESERVED_DECORATIONS = [
  "sdkSessionId",
  "forkedFromSdkSessionId",
  "pinned",
  "folderId",
  "manualOrder",
  "manualOrderSection",
  "archivedAt",
  "parentSessionId",
  "branchedFromMessageId",
  "branchKind",
  "projectId",
  // Divergence bookkeeping is Cognia's, not the source's: a re-parse must not
  // clear a flag the user has not acknowledged yet.
  "importDiverged",
  "importDivergedAt",
] as const

/** Overlay the existing row's user-owned decorations onto a re-parsed session. */
export function mergeImportedSession(
  incoming: ChatSession,
  existing: ChatSession | undefined
): ChatSession {
  if (!existing) return incoming
  const merged: ChatSession = { ...incoming }
  const source = existing as unknown as Record<string, unknown>
  const target = merged as unknown as Record<string, unknown>
  for (const key of PRESERVED_DECORATIONS) {
    if (source[key] !== undefined) target[key] = source[key]
  }
  // A manual rename (`titleAuto === false`) permanently opts out of auto-title,
  // so it must win over the re-derived title.
  if (existing.titleAuto === false) {
    merged.title = existing.title
    merged.titleAuto = false
  }
  return merged
}

/**
 * Cheap identity of a source transcript: how many messages it has plus the
 * identity of its last one.
 *
 * Deliberately not a content hash — the point is only to answer "has the source
 * moved since we last mirrored it?", and an agent that is still running appends
 * turns rather than rewriting them. Hashing every message body on every watch
 * event would cost far more than the question is worth.
 */
export function importSourceDigest(messages: readonly StoredMessage[]): string {
  const last = messages[messages.length - 1]
  return `${messages.length}:${last?.id ?? ""}:${last?.createdAt ?? 0}`
}

/**
 * Persist parsed conversations to Dexie with the clobber-guard applied. One
 * `rw` transaction over `sessions` + `messages`; reads the existing row per
 * conversation to decide skip-vs-merge. Returns counts actually written
 * (frozen sessions are excluded — but a frozen row whose source has moved is
 * flagged `importDiverged`, which is a metadata-only write).
 */
export async function applyImportedMerged(
  conversations: ImportedConversation[],
  db: Db = getDb()
): Promise<{ sessions: number; messages: number }> {
  if (conversations.length === 0) return { sessions: 0, messages: 0 }

  let sessionsWritten = 0
  let messagesWritten = 0
  const orphanCandidates = new Set<string>()

  // Image decoding/storage opens its own short Dexie transactions, so it must
  // happen before the atomic sessions/messages/ref write below. Skip rows that
  // are already frozen to avoid ingesting media for a conversation Cognia no
  // longer mirrors. The transaction re-checks the guard before committing.
  /** Frozen rows needing a source baseline or divergence update. */
  const frozenSourceUpdates: Array<{ id: string; digest: string; diverged: boolean }> = []

  const prepared = await Promise.all(
    conversations.map(async (conversation) => {
      const existing = await db.sessions.get(conversation.session.id)
      if (existing?.importFrozen) {
        // Frozen means "do not mirror", not "do not look". Comparing the cheap
        // digest is what turns a silently-ignored source edit into something the
        // user can see.
        const digest = importSourceDigest(conversation.messages)
        if (!existing.importSourceDigest) {
          frozenSourceUpdates.push({ id: conversation.session.id, digest, diverged: false })
        } else if (existing.importSourceDigest !== digest) {
          frozenSourceUpdates.push({ id: conversation.session.id, digest, diverged: true })
        }
        return null
      }
      return {
        conversation,
        messages: await Promise.all(conversation.messages.map(normalizeStoredMessageMedia)),
      }
    })
  )

  await db.transaction(
    "rw",
    [db.sessions, db.messages, db.messageMediaRefs, db.chatSearchText],
    async () => {
      const sessionRows: ChatSession[] = []
      const messageRows: StoredMessage[] = []
      for (const entry of prepared) {
        if (!entry) continue
        const { conversation: conv } = entry
        const existing = await db.sessions.get(conv.session.id)
        // Frozen: the user continued this import in Cognia — leave it untouched.
        if (existing?.importFrozen) continue
        const merged = mergeImportedSession(conv.session, existing)
        sessionRows.push({
          ...merged,
          importSourceDigest: importSourceDigest(entry.messages),
          transcriptRevision: (existing?.transcriptRevision ?? merged.transcriptRevision ?? 0) + 1,
        })
        for (const message of entry.messages) messageRows.push(message)
      }
      if (sessionRows.length > 0) await db.sessions.bulkPut(sessionRows)
      if (messageRows.length > 0) {
        const messageIds = messageRows.map((message) => message.id)
        const oldRefs = await db.messageMediaRefs.where("messageId").anyOf(messageIds).toArray()
        for (const ref of oldRefs) orphanCandidates.add(ref.hash)
        await db.messages.bulkPut(messageRows)
        await db.messageMediaRefs.where("messageId").anyOf(messageIds).delete()
        const replacementRefs = messageRows.flatMap((message) =>
          messageMediaRefRows(message.id, message.sessionId, message.parts)
        )
        if (replacementRefs.length > 0) await db.messageMediaRefs.bulkPut(replacementRefs)
        // Project into the search index in the SAME transaction (ADR-0099).
        //
        // Without this an imported conversation is unfindable by content: the
        // idle indexer only projects sessions the chat paths marked dirty, and
        // the lazy backfill is a one-way descending walk that latches
        // `complete` — so on any account whose walk already finished, history
        // imported afterwards would never be projected at all. Projecting here
        // costs nothing extra because the rows are already in hand.
        const searchRows: ChatSearchTextRow[] = []
        for (const message of messageRows) {
          const projected = projectMessageToSearchRow(message)
          if (projected) searchRows.push(projected)
        }
        if (searchRows.length > 0) await db.chatSearchText.bulkPut(searchRows)
      }
      sessionsWritten = sessionRows.length
      messagesWritten = messageRows.length
    }
  )

  // The resident corpus is ordered newest-first and an import is overwhelmingly
  // back-dated, so rebuilding it from Dexie is both cheaper and more correct
  // than folding thousands of old rows into the live one.
  if (messagesWritten > 0) invalidateResidentCorpus()

  if (orphanCandidates.size > 0) {
    await collectUnreferencedMessageMedia(orphanCandidates)
  }

  // Metadata-only, and outside the content transaction: flagging divergence must
  // never be able to fail the import it observed. `modify` leaves every other
  // field — including the frozen transcript — untouched.
  for (const { id, digest, diverged } of frozenSourceUpdates) {
    await db.sessions
      .where("id")
      .equals(id)
      .modify((row) => {
        if (diverged) {
          row.importDiverged = true
          row.importDivergedAt = Date.now()
        }
        // Record what we saw, so the same unchanged-since divergence does not
        // re-stamp a new timestamp on every subsequent watch event. For a
        // legacy frozen row this first observation establishes the baseline.
        row.importSourceDigest = digest
      })
  }

  return { sessions: sessionsWritten, messages: messagesWritten }
}
