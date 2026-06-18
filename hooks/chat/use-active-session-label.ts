"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { getCharacter } from "@/lib/db/characters"
import { getSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat/chat-store"
import type { Character, ChatSession } from "@/lib/claude/types"

export interface ActiveSessionLabel {
  /** The active chat session id, or null when nothing is open. */
  activeSessionId: string | null
  /** The active session row (live), or undefined while loading / none. */
  session: ChatSession | undefined
  /** The session's character (live), if it is a character chat. */
  character: Character | undefined
  /**
   * Display label for the active session: the character name when present,
   * else the session title, else `null`. Callers apply their own fallback
   * (e.g. the app name, or a "no session" string).
   */
  label: string | null
}

/**
 * Single source of truth for "what is the active conversation called".
 *
 * The desktop title bar, the status bar, and the OS window-title sync all need
 * the same `character name ?? session title` derivation off the active
 * session. This hook owns the two Dexie live queries so those consumers stop
 * each re-deriving it (and re-running the same queries) independently.
 */
export function useActiveSessionLabel(): ActiveSessionLabel {
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const session = useLiveQuery(
    () => (activeSessionId ? getSession(activeSessionId) : Promise.resolve(undefined)),
    [activeSessionId]
  )
  const character = useLiveQuery(
    () => (session?.characterId ? getCharacter(session.characterId) : Promise.resolve(undefined)),
    [session?.characterId]
  )
  const label = character?.name ?? session?.title ?? null
  return { activeSessionId, session, character, label }
}
