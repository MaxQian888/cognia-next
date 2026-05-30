"use client"

import { useCallback, useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listMessages, persistMessages } from "@/lib/db/messages"
import {
  bulkDeleteSessions,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  updateSession,
} from "@/lib/db/sessions"
import { resolveCharacterById } from "@/lib/db/characters"
import { buildOpeningMessage } from "@/lib/chat/opening-message"
import { getDb } from "@/lib/db/schema"
import { closeSession } from "@/lib/claude/ipc"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import type { ChatSession } from "@/lib/claude/types"
import { isTauri } from "@/lib/tauri"

export function useSessions() {
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const setMessages = useChatStore((s) => s.setMessages)
  const setMessagesLoadError = useChatStore((s) => s.setMessagesLoadError)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const messagesReloadNonce = useChatStore((s) => s.messagesReloadNonce)

  // Live-bind the session list to Dexie so other tabs / quick deletes update.
  const sessions = useLiveQuery<ChatSession[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : listSessions()),
    []
  )

  // When the active session changes, hydrate its messages from Dexie. For an
  // empty session bound to a character with a persona opening message
  // (ADR-0030), seed + persist that greeting as the first assistant turn so
  // it shows immediately and survives reload. Idempotent: once seeded the
  // session is no longer empty, so re-activating it won't re-seed.
  useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false
    listMessages(activeSessionId)
      .then(async (msgs) => {
        if (cancelled) return
        if (msgs.length === 0) {
          const session = await getSession(activeSessionId)
          const character = session?.characterId
            ? await resolveCharacterById(session.characterId)
            : null
          const opening = buildOpeningMessage(character)
          if (opening) {
            await persistMessages(activeSessionId, [opening])
            if (!cancelled) setMessages([opening])
            return
          }
        }
        if (!cancelled) setMessages(msgs)
      })
      .catch((err) => {
        // A transient Dexie read failure must not leave the conversation
        // silently blank (it reads as "history lost"). Surface it so the chat
        // pane can show an error + retry; don't overwrite the store with [].
        console.error("listMessages failed", err)
        if (!cancelled) {
          setMessagesLoadError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
    // `messagesReloadNonce` re-runs the load when the retry button bumps it.
  }, [activeSessionId, setMessages, setMessagesLoadError, messagesReloadNonce])

  const select = useCallback(
    (id: string | null) => {
      setActiveSession(id)
    },
    [setActiveSession]
  )

  const create = useCallback(
    async (
      partial?: Partial<
        Pick<
          ChatSession,
          "title" | "model" | "systemPrompt" | "workingDir" | "kind" | "characterId" | "teamId"
        >
      >
    ) => {
      const s = await createSession(partial)
      // Auto-link the new session to the active workspace so it groups under
      // that project (persisted via `project.sessionIds`). No-op when no
      // workspace is active.
      const { activeProjectId, addSessionToProject } = useProjectStore.getState()
      if (activeProjectId) addSessionToProject(activeProjectId, s.id)
      setActiveSession(s.id)
      return s
    },
    [setActiveSession]
  )

  const remove = useCallback(
    async (id: string) => {
      // Tear down the live session in the sidecar if any.
      if (isTauri()) {
        try {
          await closeSession(id)
        } catch (err) {
          // Non-fatal — the sidecar may not have a session for this id.
          console.warn("closeSession failed", err)
        }
      }
      await deleteSession(id)
      if (useChatStore.getState().activeSessionId === id) {
        setActiveSession(null)
      }
    },
    [setActiveSession]
  )

  const rename = useCallback(async (id: string, title: string) => {
    // A manual rename opts the session out of auto-title generation.
    await updateSession(id, { title, titleAuto: false })
  }, [])

  const bulkRemove = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return
      // Tear down each live sidecar session first; tolerate per-id failures
      // (the sidecar may not be tracking some of these ids).
      if (isTauri()) {
        await Promise.all(
          ids.map(async (id) => {
            try {
              await closeSession(id)
            } catch (err) {
              console.warn("closeSession failed", err)
            }
          })
        )
      }
      await bulkDeleteSessions(ids)
      const current = useChatStore.getState().activeSessionId
      if (current && ids.includes(current)) {
        setActiveSession(null)
      }
    },
    [setActiveSession]
  )

  const bulkSetPinned = useCallback(async (ids: readonly string[], pinned: boolean) => {
    if (ids.length === 0) return
    await Promise.all(ids.map((id) => updateSession(id, { pinned })))
  }, [])

  return {
    sessions: sessions ?? [],
    // `useLiveQuery` returns `undefined` until the first Dexie read resolves;
    // distinguishing that from a genuinely empty list lets the session list
    // show a skeleton instead of flashing the empty state on cold start.
    isLoadingSessions: sessions === undefined,
    activeSessionId,
    select,
    create,
    remove,
    rename,
    bulkRemove,
    bulkSetPinned,
    db: typeof window === "undefined" ? null : getDb(),
  }
}
