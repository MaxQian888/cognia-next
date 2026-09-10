// Helpers used by the Clear-data section of the settings dialog. Each helper
// is destructive — the UI requires the user to type "DELETE" to confirm.

import { getDb } from "@/lib/db/schema"
import { clearDraft } from "@/lib/db/chat-drafts"
import { collectUnreferencedMessageMedia } from "@/lib/db/message-media-refs"
import { recordTombstones } from "@/lib/sync/tombstones"
import { loggers } from "@cognia/logging"

export type ClearableTable =
  "sessions" | "characters" | "skills" | "teams" | "promptPresets" | "mcpServers" | "settings"

/**
 * Clear the named tables. Sessions also clear their associated messages,
 * draft/unread state and derived transcript/media indexes. Built-in
 * characters/skills/teams will be re-seeded automatically on next read.
 */
export async function clearTables(names: ClearableTable[]): Promise<void> {
  if (names.length === 0) return
  const db = getDb()
  const wantsSessions = names.includes("sessions")
  const draftSessionIds = new Set<string>()
  const orphanCandidates = new Set<string>()

  await db.transaction(
    "rw",
    [
      db.sessions,
      db.messages,
      db.sessionState,
      db.chatDrafts,
      db.chatInputHistory,
      db.messageMediaRefs,
      db.chatTurnSummaries,
      db.chatTranscriptIndexState,
      db.syncTombstones,
      db.characters,
      db.skills,
      db.teams,
      db.promptPresets,
      db.mcpServers,
      db.settings,
    ],
    async () => {
      if (wantsSessions) {
        const sessionIds = await db.sessions.toCollection().primaryKeys()
        const messageIds = await db.messages.toCollection().primaryKeys()
        const stateIds = await db.sessionState.toCollection().primaryKeys()
        const draftIds = await db.chatDrafts.toCollection().primaryKeys()
        for (const id of [...sessionIds, ...draftIds]) draftSessionIds.add(id)
        for (const hash of await db.messageMediaRefs.orderBy("hash").uniqueKeys()) {
          orphanCandidates.add(String(hash))
        }
        await db.messages.clear()
        await db.sessionState.clear()
        await db.chatDrafts.clear()
        await db.chatInputHistory.clear()
        await db.messageMediaRefs.clear()
        await db.chatTurnSummaries.clear()
        await db.chatTranscriptIndexState.clear()
        await db.sessions.clear()
        const at = Date.now()
        await recordTombstones("sessions", sessionIds, at)
        await recordTombstones("messages", messageIds, at)
        await recordTombstones("sessionState", stateIds, at)
      }
      if (names.includes("characters")) await db.characters.clear()
      if (names.includes("skills")) await db.skills.clear()
      if (names.includes("teams")) await db.teams.clear()
      if (names.includes("promptPresets")) await db.promptPresets.clear()
      if (names.includes("mcpServers")) await db.mcpServers.clear()
      if (names.includes("settings")) await db.settings.clear()
    }
  )
  // External cleanup follows the multi-table commit so a failed reset cannot
  // cancel a live draft or remove media whose references were rolled back.
  for (const sessionId of draftSessionIds) {
    try {
      await clearDraft(sessionId, { hostAlreadyCleared: true })
    } catch (error) {
      loggers.store.warn("cleared session draft cleanup failed", {
        sessionId,
        error: String(error),
      })
    }
  }
  if (orphanCandidates.size > 0) {
    try {
      await collectUnreferencedMessageMedia(orphanCandidates)
    } catch (error) {
      loggers.store.warn("cleared session media cleanup failed", { error: String(error) })
    }
  }
}

/**
 * Drop the entire database. The page must reload afterwards so Dexie can
 * re-open and re-run the seed step.
 */
export async function clearAll(): Promise<void> {
  const db = getDb()
  await db.delete()
}
