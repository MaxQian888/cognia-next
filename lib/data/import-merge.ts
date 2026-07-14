// Guarded persistence for external-agent session imports (ADR-0062 fidelity
// upgrade). A naive `bulkPut` replaces the whole `ChatSession` row, which — on
// a RE-import of a session the user already continued in Cognia — would wipe
// its `sdkSessionId` (breaking SDK resume) plus every local decoration (pin,
// folder, manual order, rename, archive). Live fs-watch re-imports make that
// re-import path routine, so the write must merge instead of clobber:
//
//   • `importFrozen` session  → SKIP entirely. The user continued it, so Cognia
//     owns the thread; source-side edits must never touch it (they surface as a
//     "diverged" badge instead — freeze is set in `use-claude-chat.ts`).
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
 * Persist parsed conversations to Dexie with the clobber-guard applied. One
 * `rw` transaction over `sessions` + `messages`; reads the existing row per
 * conversation to decide skip-vs-merge. Returns counts actually written
 * (frozen sessions are excluded).
 */
export async function applyImportedMerged(
  conversations: ImportedConversation[],
  db: Db = getDb()
): Promise<{ sessions: number; messages: number }> {
  if (conversations.length === 0) return { sessions: 0, messages: 0 }

  let sessionsWritten = 0
  let messagesWritten = 0

  await db.transaction("rw", [db.sessions, db.messages], async () => {
    const sessionRows: ChatSession[] = []
    const messageRows: StoredMessage[] = []
    for (const conv of conversations) {
      const existing = await db.sessions.get(conv.session.id)
      // Frozen: the user continued this import in Cognia — leave it untouched.
      if (existing?.importFrozen) continue
      sessionRows.push(mergeImportedSession(conv.session, existing))
      for (const m of conv.messages) messageRows.push(m)
    }
    if (sessionRows.length > 0) await db.sessions.bulkPut(sessionRows)
    if (messageRows.length > 0) await db.messages.bulkPut(messageRows)
    sessionsWritten = sessionRows.length
    messagesWritten = messageRows.length
  })

  return { sessions: sessionsWritten, messages: messagesWritten }
}
