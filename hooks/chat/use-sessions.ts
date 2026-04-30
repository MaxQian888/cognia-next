"use client"

import { useCallback, useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listMessages } from "@/lib/db/messages"
import { createSession, deleteSession, listSessions, updateSession } from "@/lib/db/sessions"
import { getDb } from "@/lib/db/schema"
import { closeSession } from "@/lib/claude/ipc"
import { useChatStore } from "@/stores/chat"
import type { ChatSession } from "@/lib/claude/types"
import { isTauri } from "@/lib/tauri"

export function useSessions() {
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const setMessages = useChatStore((s) => s.setMessages)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  // Live-bind the session list to Dexie so other tabs / quick deletes update.
  const sessions = useLiveQuery<ChatSession[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : listSessions()),
    []
  )

  // When the active session changes, hydrate its messages from Dexie.
  useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false
    listMessages(activeSessionId)
      .then((msgs) => {
        if (!cancelled) setMessages(msgs)
      })
      .catch((err) => {
        console.error("listMessages failed", err)
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionId, setMessages])

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
    await updateSession(id, { title })
  }, [])

  return {
    sessions: sessions ?? [],
    activeSessionId,
    select,
    create,
    remove,
    rename,
    db: typeof window === "undefined" ? null : getDb(),
  }
}
