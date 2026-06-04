// Resolves the active session's `characterId` so the pet widget can bind its
// view to the currently-open character. The active-session pointer lives in
// `useChatStore`; the session row (with `characterId`) lives in Dexie, so we
// subscribe narrowly to the id and reactively read the row via `useLiveQuery`.
// Returns `undefined` when there is no active session, the session is missing,
// or it carries no character.

"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { useChatStore } from "@/stores/chat/chat-store"
import { getSession } from "@/lib/db/sessions"

export function useActiveCharacterId(): string | undefined {
  // Narrow selector — returns the primitive id, so the hook only re-renders
  // when the active session actually changes (no fresh-object churn).
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  return useLiveQuery(
    async () => {
      if (!activeSessionId) return undefined
      const session = await getSession(activeSessionId)
      return session?.characterId ?? undefined
    },
    [activeSessionId],
    undefined
  )
}
