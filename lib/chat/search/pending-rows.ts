/**
 * Search-text projections for the messages the idle indexer has not written yet.
 *
 * The index deliberately trails streaming writes, so the message a user is most
 * likely searching for — the one that just arrived — is the one Dexie does not
 * have. `searchChatHistory` scans these first and de-duplicates their ids
 * against the resident corpus.
 *
 * Lives here rather than inside `use-chat-history-search.ts` because it is not
 * hook state: it is a pure read of the chat store, and it now has two callers
 * (the sidebar's history search and the composer's `@msg:` source). It stays
 * OUT of `engine.ts` for the reason that module's `pendingRows` dep exists at
 * all — the engine is store-free, and a static import of the chat store there
 * would make every engine test mount one.
 */

import type { UIMessage } from "ai"

import type { ChatSearchTextRow } from "@/lib/db/chat-search-text"
import { projectSearchText } from "./project-text"
import { useChatStore } from "@/stores/chat"

function createdAtOf(message: UIMessage): number {
  const value = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now()
}

/** Project the open chat slices without touching Dexie. */
export function pendingSearchRows(): ChatSearchTextRow[] {
  const state = useChatStore.getState()
  const bySession = new Map<string, readonly UIMessage[]>()
  for (const [sessionId, slice] of Object.entries(state.sessions)) {
    bySession.set(sessionId, slice.messages)
  }
  if (state.activeSessionId) {
    bySession.set(state.activeSessionId, state.messages)
  }

  const rows: ChatSearchTextRow[] = []
  const seen = new Set<string>()
  for (const [sessionId, messages] of bySession) {
    for (const message of messages) {
      if (!message.id || seen.has(message.id)) continue
      seen.add(message.id)
      const text = projectSearchText(message.parts)
      if (!text) continue
      rows.push({
        messageId: message.id,
        sessionId,
        // Empty, not the real workspace: these rows never reach a
        // `[projectId+createdAt]` index — they are scanned in memory — and the
        // engine's workspace filter reads the SESSION, not the row.
        projectId: "",
        role: message.role,
        createdAt: createdAtOf(message),
        text,
      })
    }
  }
  return rows
}
